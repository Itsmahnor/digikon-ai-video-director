// Drives one project with uploaded pictures through the console API: upload -> analysis -> corrections -> route -> direct -> both approvals -> editor -> render.
// Usage: node scripts/drive-assets.mjs <base-url> <out-json> <project-json>
// It approves both gates automatically, so it is for quality experiments on a local console only, never for production approval.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [base = "http://localhost:4180", outFile = "drive-assets.json", projectFile] = process.argv.slice(2);
const project = JSON.parse(readFileSync(projectFile, "utf8"));
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
};
const log = {};
const save = () => writeFileSync(outFile, JSON.stringify(log, null, 1));
const { json: s } = await call("POST", "/api/sessions");
log.session = s.id;

const form = new FormData();
for (const p of project.files) form.append("files", new Blob([readFileSync(p.path)]), p.name ?? basename(p.path));
const up = await (await fetch(`${base}/api/sessions/${s.id}/assets`, { method: "POST", body: form })).json();
log.upload = { added: up.added?.map((a) => ({ asset_id: a.asset_id, name: a.metadata.original_name })), rejected: up.rejected };
let gallery;
for (let i = 0; i < 200; i++) {
  gallery = (await call("GET", `/api/sessions/${s.id}/gallery`)).json;
  if (gallery.items.length && gallery.items.every((x) => x.status !== "running" && x.status !== "pending")) break;
  await new Promise((r) => setTimeout(r, 1500));
}
log.gallery_detected = gallery.items;
save();
const idOf = (name) => up.added.find((a) => a.metadata.original_name === name)?.asset_id;
for (const c of project.corrections ?? []) log[`correction_${c.name}`] = (await call("POST", `/api/sessions/${s.id}/assets/${idOf(c.name)}/correction`, c.body)).json;
log.gallery_corrected = (await call("GET", `/api/sessions/${s.id}/gallery`)).json.items;
save();

const route = await call("POST", `/api/sessions/${s.id}/route`, { text: project.text });
log.route = route.json;
if (route.json.result?.status !== "ready") { save(); console.log("route not ready", JSON.stringify(route.json).slice(0, 800)); process.exit(2); }
const r = await fetch(`${base}/api/sessions/${s.id}/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facts: project.facts ?? [] }) });
const t = await r.text();
const events = [...t.matchAll(/event: (\w+)\ndata: (.*)/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
const state = events.find((e) => e.event === "state")?.data;
const fail = events.find((e) => e.event === "failure");
if (fail || !state) { log.direct_failure = fail ?? events; save(); console.log("direct failed", JSON.stringify(fail ?? events).slice(0, 1500)); process.exit(3); }
log.state1 = state;
save();
const decide = (stage, version, extra = {}) => call("POST", `/api/sessions/${s.id}/approve`, { stage, plan_version: version, decision: "approved", notes: "", ...extra });
const sbVersion = state.storyboard?.version ?? state.scenePlan?.version ?? 1;
const a1 = await decide("storyboard", sbVersion);
log.approve1 = { status: a1.status, st: a1.json.state?.status };
const epVersion = a1.json.state?.edit_plan?.version ?? a1.json.state?.editPlan?.version ?? 1;
const a2 = await decide("edit_plan", epVersion, { storyboard_version: sbVersion });
log.approve2 = { status: a2.status, st: a2.json.state?.status, err: a2.status !== 200 ? a2.json : undefined };
log.state_final = a2.json.state;
const ed = await call("POST", `/api/sessions/${s.id}/editor`);
log.editor = { status: ed.status, st: ed.json.output?.status, conflicts: ed.json.output?.conflicts, revisions: ed.json.output?.revision_requests, reasons: ed.json.reasons };
log.render_plan = (await call("POST", `/api/sessions/${s.id}/render/plan`, { settings: project.settings })).json;
save();
const rr = await call("POST", `/api/sessions/${s.id}/render`, { settings: project.settings });
log.render = { status: rr.status, body: rr.json };
log.gallery_final = (await call("GET", `/api/sessions/${s.id}/gallery`)).json.items;
save();
console.log("session", s.id, "render status", rr.status, JSON.stringify(rr.json).slice(0, 800));