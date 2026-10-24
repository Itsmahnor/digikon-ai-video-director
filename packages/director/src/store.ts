import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ApprovalRecord, DirectorHandoff, type ApprovalStage } from "@digikon/contracts";
import { DIRECTOR_GRAPH_VERSION } from "./graph.js";
import { checkHandoff, type AssetFiles } from "./handoff.js";
import { CHECKPOINT_FORMAT, DirectorCheckpoint } from "./resume.js";
import type { RecipeLibrary } from "@digikon/recipes";

/**
 * Local, file-based storage for approval records and handoffs, under a session's storage folder:
 *
 *   <session dir>/runs/<run_id>/approvals/000001.json   one decision per file, numbered in the order they were made
 *   <session dir>/runs/<run_id>/handoff.json            the latest handoff built for the run
 *   <session dir>/runs/<run_id>/checkpoint.json         the run's state where it last stopped (a gate, approved or escalated)
 *
 * Every file is an envelope { format, format_version, run_id, ... } around a record that is schema-checked on load.
 * Writes go to a temporary file, are flushed to disk, then moved into place, so a crash leaves either the old state or a
 * complete new file, never a half-written one under a valid name. Approval files are never overwritten.
 *
 * Trust boundary: this protects against crashes, partial writes and accidental edits. It does not stop someone with write
 * access to the storage folder from changing both a plan and its stored approval. Hashes here are not signatures.
 */
export const STORE_FORMAT_VERSION = 1;
const APPROVAL_FORMAT = "digikon.approval";
const HANDOFF_FORMAT = "digikon.handoff";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const APPROVAL_FILE = /^(\d{6})\.json$/;

export class PersistenceError extends Error {
  constructor(message: string) { super(message); this.name = "PersistenceError"; }
}

/** Where the gate node sends each decision. A throw aborts the decision, so nothing unsaved is ever treated as decided. */
export interface ApprovalLog { append(record: ApprovalRecord): void }

export interface RunStoreOptions {
  /** Moves a fully written temporary file into place. Replaceable in tests to simulate a failed write. */
  commit?: (tmp: string, final: string, overwrite: boolean) => void;
}

const defaultCommit = (tmp: string, final: string, overwrite: boolean) => {
  if (overwrite) { renameSync(tmp, final); return; }
  linkSync(tmp, final); // fails if the file exists: an approval is never replaced
  unlinkSync(tmp);
};

export class RunStore {
  private readonly commit: NonNullable<RunStoreOptions["commit"]>;
  constructor(readonly sessionDir: string, opts: RunStoreOptions = {}) { this.commit = opts.commit ?? defaultCommit; }

  private runDir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new PersistenceError(`"${runId}" is not a valid run id`);
    return join(this.sessionDir, "runs", runId);
  }

  private write(final: string, data: unknown, overwrite: boolean): void {
    const tmp = `${final}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      const fd = openSync(tmp, "wx");
      try { writeSync(fd, `${JSON.stringify(data, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      this.commit(tmp, final, overwrite);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* the leftover .tmp file is ignored on load */ }
      throw new PersistenceError(`could not save ${final}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Writes one decision under an exact sequence number. Refuses to replace an existing record. */
  writeApprovalFile(runId: string, seq: number, record: ApprovalRecord): void {
    const dir = join(this.runDir(runId), "approvals");
    mkdirSync(dir, { recursive: true });
    const final = join(dir, `${String(seq).padStart(6, "0")}.json`);
    if (existsSync(final)) throw new PersistenceError(`approval ${seq} of run ${runId} already exists and is never overwritten`);
    this.write(final, { format: APPROVAL_FORMAT, format_version: STORE_FORMAT_VERSION, run_id: runId, seq, record: ApprovalRecord.parse(record) }, false);
  }

  /** Appends a decision after the last stored one. */
  appendApproval(runId: string, record: ApprovalRecord): void {
    const dir = join(this.runDir(runId), "approvals");
    const last = existsSync(dir) ? Math.max(0, ...readdirSync(dir).map((f) => APPROVAL_FILE.exec(f)?.[1]).filter((n): n is string => !!n).map(Number)) : 0;
    this.writeApprovalFile(runId, last + 1, record);
  }

  approvalLog(runId: string): ApprovalLog {
    this.runDir(runId); // validate now, not at the first decision
    return { append: (record) => this.appendApproval(runId, record) };
  }

  /**
   * Every stored decision, oldest first, each validated. Any file that cannot be trusted is reported; callers must then
   * fail closed rather than use the records that did load. A missing folder means nothing was stored (no problem, no records).
   */
  loadApprovals(runId: string): { records: ApprovalRecord[]; problems: string[] } {
    const dir = join(this.runDir(runId), "approvals");
    if (!existsSync(dir)) return { records: [], problems: [] };
    const records: ApprovalRecord[] = [];
    const problems: string[] = [];
    const files = readdirSync(dir).filter((f) => !f.endsWith(".tmp")).sort(); // a .tmp file is an unfinished write, never a record
    let expected = 1;
    for (const f of files) {
      const m = APPROVAL_FILE.exec(f);
      if (!m) { problems.push(`${f} is not an approval file`); continue; }
      const seq = Number(m[1]);
      for (; expected < seq; expected++) problems.push(`approval ${String(expected).padStart(6, "0")}.json is missing (the sequence has a gap)`);
      expected = seq + 1;
      let env: Record<string, unknown>;
      try { env = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { problems.push(`${f} is not valid JSON (it may be an interrupted write)`); continue; }
      if (env.format !== APPROVAL_FORMAT || env.format_version !== STORE_FORMAT_VERSION) { problems.push(`${f} has unsupported format ${String(env.format)} version ${String(env.format_version)}`); continue; }
      if (env.run_id !== runId) { problems.push(`${f} belongs to run ${String(env.run_id)}, not ${runId}`); continue; }
      if (env.seq !== seq) { problems.push(`${f} says it is approval ${String(env.seq)}`); continue; }
      const p = ApprovalRecord.safeParse(env.record);
      if (!p.success) { problems.push(`${f} is not a valid approval record (${p.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; ")})`); continue; }
      records.push(p.data);
    }
    return { records, problems };
  }

  /**
   * Replaces the run's checkpoint atomically. Throws PersistenceError when it could not be written; the previous checkpoint
   * is then left as it was, and the caller must not report the new progress as saved.
   */
  saveCheckpoint(cp: DirectorCheckpoint): void {
    const dir = this.runDir(cp.run_id);
    mkdirSync(dir, { recursive: true });
    this.write(join(dir, "checkpoint.json"), DirectorCheckpoint.parse(cp), true);
  }

  /** The saved checkpoint, fully checked. `checkpoint` is null when none exists or it cannot be used (see `problems`). */
  loadCheckpoint(runId: string): { checkpoint: DirectorCheckpoint | null; problems: string[] } {
    const file = join(this.runDir(runId), "checkpoint.json");
    if (!existsSync(file)) return { checkpoint: null, problems: [] };
    const fail = (p: string) => ({ checkpoint: null, problems: [p] });
    let env: Record<string, unknown>;
    try { env = JSON.parse(readFileSync(file, "utf8")); } catch { return fail("checkpoint.json is not valid JSON (it may be an interrupted write)"); }
    if (env.format !== CHECKPOINT_FORMAT || env.format_version !== 1) return fail(`checkpoint.json has unsupported format ${String(env.format)} version ${String(env.format_version)}`);
    if (env.graph_version !== DIRECTOR_GRAPH_VERSION) return fail(`checkpoint.json was made by graph version ${String(env.graph_version)}, but this server runs ${DIRECTOR_GRAPH_VERSION}`);
    if (env.run_id !== runId) return fail(`checkpoint.json belongs to run ${String(env.run_id)}, not ${runId}`);
    const p = DirectorCheckpoint.safeParse(env);
    if (!p.success) return fail(`checkpoint.json is not a valid Director state (${p.error.issues.map((i) => `${i.path.join(".") || "checkpoint"}: ${i.message}`).join("; ")})`);
    return { checkpoint: p.data, problems: [] };
  }

  saveHandoff(handoff: DirectorHandoff): void {
    const dir = this.runDir(handoff.run.run_id);
    mkdirSync(dir, { recursive: true });
    this.write(join(dir, "handoff.json"), { format: HANDOFF_FORMAT, format_version: STORE_FORMAT_VERSION, run_id: handoff.run.run_id, handoff: DirectorHandoff.parse(handoff) }, true);
  }

  /** The stored handoff, schema-checked. `handoff` is null when none was stored or it cannot be trusted (see `problems`). */
  loadHandoff(runId: string): { handoff: DirectorHandoff | null; problems: string[] } {
    const file = join(this.runDir(runId), "handoff.json");
    if (!existsSync(file)) return { handoff: null, problems: [] };
    let env: Record<string, unknown>;
    try { env = JSON.parse(readFileSync(file, "utf8")); } catch { return { handoff: null, problems: ["handoff.json is not valid JSON (it may be an interrupted write)"] }; }
    if (env.format !== HANDOFF_FORMAT || env.format_version !== STORE_FORMAT_VERSION) return { handoff: null, problems: [`handoff.json has unsupported format ${String(env.format)} version ${String(env.format_version)}`] };
    const p = DirectorHandoff.safeParse(env.handoff);
    if (!p.success) return { handoff: null, problems: [`handoff.json is not a valid handoff (${p.error.issues.map((i) => `${i.path.join(".") || "handoff"}: ${i.message}`).join("; ")})`] };
    if (env.run_id !== runId || p.data.run.run_id !== runId) return { handoff: null, problems: [`handoff.json belongs to another run`] };
    return { handoff: p.data, problems: [] };
  }
}

const STAGE_LABEL: Record<ApprovalStage, string> = { storyboard: "storyboard", edit_plan: "edit-plan" };
const COMPARED = ["decided_at", "decision", "evidence_hash", "notes", "plan_hash", "plan_version", "stage", "storyboard_version"] as const;

/**
 * Verifies a handoff against the approvals stored for its run, which are the trusted reference: the handoff's own records
 * and hashes are never enough on their own. Fails closed when the stored records are missing, unreadable or inconsistent,
 * then runs every check of `checkHandoff` (integrity, evidence, derived sections, plan validity, recipe versions, files).
 */
export function verifyHandoffWithStore(
  handoff: DirectorHandoff,
  store: RunStore,
  ctx: { recipes: RecipeLibrary; files?: AssetFiles; storageRoot?: string; requireContentHash?: boolean },
): string[] {
  const runId = handoff.run.run_id;
  const { records, problems } = store.loadApprovals(runId);
  if (problems.length) return problems.map((p) => `stored approvals cannot be trusted: ${p}`);
  const reasons: string[] = [];
  for (const stage of ["storyboard", "edit_plan"] as const) {
    const latest = [...records].reverse().find((r) => r.stage === stage);
    if (!latest) { reasons.push(`there is no stored ${STAGE_LABEL[stage]} approval for run ${runId}`); continue; }
    if (latest.decision !== "approved") { reasons.push(`the latest stored ${STAGE_LABEL[stage]} decision for run ${runId} is a change request, not an approval`); continue; }
    const mine = handoff.approvals[stage] as Record<string, unknown>;
    const differ = COMPARED.filter((k) => JSON.stringify(mine[k] ?? null) !== JSON.stringify((latest as Record<string, unknown>)[k] ?? null));
    if (differ.length) reasons.push(`the handoff's ${STAGE_LABEL[stage]} approval does not match the stored record (${differ.join(", ")} differ${differ.length === 1 ? "s" : ""})`);
  }
  return [...reasons, ...checkHandoff(handoff, ctx)];
}
