// Re-renders a stored, approved run through the console API (the same route the UI uses) and writes the delivery report and the frames to inspect.
// Usage: node scripts/render-regression.mjs <base-url> <session-id> <run-id> <out-dir> [width height fps duration_s]
// It approves nothing: the run must already hold both approvals, and the stored Editor output is used as it is.
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import http from "node:http";

const [base, sid, rid, out, w = "1280", h = "720", fps = "30", dur = "60"] = process.argv.slice(2);
if (!base || !sid || !rid || !out) { console.error("usage: node scripts/render-regression.mjs <base-url> <session-id> <run-id> <out-dir> [width height fps duration_s]"); process.exit(2); }
mkdirSync(out, { recursive: true });
// node:http with no timeout: a full render takes several minutes, longer than fetch waits for response headers
const call = (method, path, body) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers: { "content-type": "application/json" }, timeout: 0 }, (r) => {
    let text = ""; r.setEncoding("utf8"); r.on("data", (c) => { text += c; });
    r.on("end", () => { try { resolve({ status: r.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: r.statusCode, json: text }); } });
  });
  req.on("error", reject); req.setTimeout(0);
  if (body) req.write(JSON.stringify(body));
  req.end();
});const settings = { aspect_ratio: "16:9", width: Number(w), height: Number(h), fps: Number(fps), duration_s: Number(dur), container: "mp4", video_codec: "h264", audio_codec: null };
const resume = await call("POST", `/api/sessions/${sid}/runs/${rid}/resume`);
console.log("resume", resume.status);
// the Editor is deterministic (no model is called) and only turns the approved plans into operations; run again, it makes the stored result current when a skill or recipe file has changed since
const editor = await call("POST", `/api/sessions/${sid}/editor`);
console.log("editor", editor.status, editor.json.output?.status, `${editor.json.output?.operations?.length ?? 0} operations`);
const plan = await call("POST", `/api/sessions/${sid}/render/plan`, { settings });
writeFileSync(join(out, "plan.json"), JSON.stringify(plan.json, null, 1));
console.log("plan", plan.status, "can_render", plan.json.can_render, "assembly complete", plan.json.assembly?.complete);
const t0 = Date.now();
const res = await call("POST", `/api/sessions/${sid}/render`, { settings });
writeFileSync(join(out, "render.json"), JSON.stringify(res.json, null, 1));
console.log("render", res.status, res.json.kind ?? res.json.error, `${Math.round((Date.now() - t0) / 1000)}s`);
const d = res.json.delivery;
if (d) console.log(JSON.stringify({ status: d.status, label: d.label, output: { ...d.output, path: undefined, video_url: undefined } }, null, 1));
