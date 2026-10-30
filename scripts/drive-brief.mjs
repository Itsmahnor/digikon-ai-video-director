// Drives one brief through the console API: route -> direct -> approve storyboard -> approve edit plan -> editor -> render.
// Usage: node scripts/drive-brief.mjs <base-url> <out-json> [brief-json]
// It approves both gates automatically, so it is for quality experiments on a local console only, never for production approval.
import { writeFileSync, readFileSync } from "node:fs";

const [base = "http://localhost:4180", outFile = "drive-result.json", briefFile] = process.argv.slice(2);
const brief = briefFile ? JSON.parse(readFileSync(briefFile, "utf8")) : {
  text: "A 20 second YouTube explainer for Slotly, a scheduling app for small business owners. Calm, clear, modern. The goal is free trial sign-ups. Audience: small business owners who lose hours to back-and-forth booking emails. No footage, no logo file, no voiceover, no music.",
  facts: ["Free for 14 days.", "Works with Google Calendar and Outlook."],
  settings: { aspect_ratio: "16:9", width: 1280, height: 720, fps: 30, duration_s: 20, container: "mp4", video_codec: "h264", audio_codec: null },
};

const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, text };
};
const log = {};
const { json: s } = await call("POST", "/api/sessions");
log.session = s.id;
const route = await call("POST", `/api/sessions/${s.id}/route`, { text: brief.text });
log.route = route.json;
if (route.json.result?.status !== "ready") { writeFileSync(outFile, JSON.stringify(log, null, 1)); console.log("route not ready", JSON.stringify(route.json).slice(0, 600)); process.exit(2); }

const sse = async () => {
  const r = await fetch(`${base}/api/sessions/${s.id}/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: brief.facts }) });
  const t = await r.text();
  const ev = [...t.matchAll(/event: (\w+)\ndata: (.*)/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
  return ev;
};
const events = await sse();
const state = events.find((e) => e.event === "state")?.data;
const fail = events.find((e) => e.event === "failure");
if (fail || !state) { log.direct_failure = fail ?? events; writeFileSync(outFile, JSON.stringify(log, null, 1)); console.log("direct failed", JSON.stringify(fail ?? events).slice(0, 800)); process.exit(3); }
log.state1 = state;
const decide = async (stage, version, extra = {}) => call("POST", `/api/sessions/${s.id}/approve`, { stage, plan_version: version, decision: "approved", notes: "", ...extra });
const sbVersion = state.storyboard?.version ?? state.scenePlan?.version ?? 1;
const a1 = await decide("storyboard", sbVersion);
log.approve1 = { status: a1.status, gate: a1.json.state?.gate, st: a1.json.state?.status };
const st2 = a1.json.state;
const epVersion = st2?.edit_plan?.version ?? st2?.editPlan?.version ?? 1;
const a2 = await decide("edit_plan", epVersion, { storyboard_version: sbVersion });
log.approve2 = { status: a2.status, st: a2.json.state?.status, err: a2.status !== 200 ? a2.json : undefined };
log.state_final = a2.json.state;
const ed = await call("POST", `/api/sessions/${s.id}/editor`);
log.editor = { status: ed.status, st: ed.json.output?.status, conflicts: ed.json.output?.conflicts, revisions: ed.json.output?.revision_requests, reasons: ed.json.reasons };
const plan = await call("POST", `/api/sessions/${s.id}/render/plan`, { settings: brief.settings });
log.render_plan = plan.json;
const rr = await call("POST", `/api/sessions/${s.id}/render`, { settings: brief.settings });
log.render = { status: rr.status, body: rr.json };
writeFileSync(outFile, JSON.stringify(log, null, 1));
console.log("session", s.id, "render status", rr.status, JSON.stringify(rr.json).slice(0, 1500));
