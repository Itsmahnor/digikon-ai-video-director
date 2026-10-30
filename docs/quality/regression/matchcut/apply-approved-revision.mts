// Records the user's explicit approval (chat message cmsg_01HyLj5rXiPWoV8kXiZ3eNwqXV2PoS2ro4XBqUeRfmuDMt) of storyboard v2 and edit plan v2 as a NEW session and run.
// The original session 9a44fee151f6 (its approvals, checkpoint and renders) is only read, never written.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ApprovalRecord, editPlanHash, evidenceHash, storyboardHash } from "../../../../packages/contracts/src/index.js";
import { RunStore, checkpointOf } from "../../../../packages/director/src/index.js";

const OLD = "9a44fee151f6", NEW = "9a44fee151f7";
const oldDir = join("storage", "sessions", OLD), newDir = join("storage", "sessions", NEW);
if (existsSync(newDir)) { console.log("already exists:", newDir); process.exit(0); }
mkdirSync(newDir, { recursive: true });
mkdirSync(join(newDir, "uploads"), { recursive: true });

const cp = JSON.parse(readFileSync(join(oldDir, "runs", `${OLD}-1793346641368`, "checkpoint.json"), "utf8"));
const sb2 = JSON.parse(readFileSync("docs/quality/regression/matchcut/storyboard-v2.json", "utf8"));
const ep2 = JSON.parse(readFileSync("docs/quality/regression/matchcut/edit-plan-v2.json", "utf8"));
const runId = `${NEW}-${Date.now()}`;
const state = { ...cp.state, scenePlan: sb2, editPlan: ep2, approvals: [], gate: null, status: "approved" };

const sbHash = storyboardHash(state.treatmentDoc, state.scenePlan);
const sbRef = { version: state.scenePlan.version, hash: sbHash };
const ev = evidenceHash({ treatment: state.treatmentDoc, scenePlan: state.scenePlan, assets: state.assets, facts: state.facts ?? [], notes: state.notes ?? [] });
const note = "Approved by Digikon in the project thread (message cmsg_01HyLj5rXiPWoV8kXiZ3eNwqXV2PoS2ro4XBqUeRfmuDMt): S03 storyboard revision 2 and edit plan revision 2, as reviewed.";
const at = new Date().toISOString();
const records = [
  ApprovalRecord.parse({ stage: "storyboard", plan_version: sb2.version, storyboard_version: sb2.version, plan_hash: sbHash, evidence_hash: ev, decision: "approved", notes: note, decided_at: at }),
  ApprovalRecord.parse({ stage: "edit_plan", plan_version: ep2.version, storyboard_version: sb2.version, plan_hash: editPlanHash(sbRef, state.editPlan), evidence_hash: ev, decision: "approved", notes: note, decided_at: at }),
];
state.approvals = records;
const store = new RunStore(newDir);
for (const r of records) store.appendApproval(runId, r);
store.saveCheckpoint(checkpointOf(state, { session_id: NEW, run_id: runId }));
console.log(JSON.stringify({ session: NEW, run: runId, storyboard_hash: sbHash.slice(0, 12), edit_plan_hash: records[1]!.plan_hash.slice(0, 12) }));
void cpSync; void rmSync;
