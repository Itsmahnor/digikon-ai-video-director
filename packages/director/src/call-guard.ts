import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The meter for real Anthropic calls. `AnthropicClient` (llm.ts) is the only code that reaches the API, and it asks this meter before every request and tells it the result after.
 * Every real request is counted, and one line per request is appended to storage/call-log.jsonl: when, which node, which model and the tokens used. A request that is never
 * sent (a scripted or demo client, a replayed fixture) is not counted here.
 */

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const DEFAULT_CALL_LOG = join(repoRoot, "storage", "call-log.jsonl");

export interface CallLogLine {
  ts: string;
  /** The request's number in this process, counting from 1. */
  n: number;
  /** The structured-output name of the request, for example "treatment" or "storyboard". */
  node: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  outcome: "ok" | "error";
}

export interface MeterOptions {
  env?: () => Record<string, string | undefined>;
  now?: () => Date;
  /** Where lines are appended. Default: REAL_CALL_LOG, else storage/call-log.jsonl. */
  logPath?: () => string;
  /** Where the end-of-run total is printed. Default: stderr. */
  print?: (line: string) => void;
}

export class CallMeter {
  private count = 0;
  private turnedAway = 0;
  private exitHook = false;
  private warned = false;
  private readonly env: () => Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly logPath: () => string;
  private readonly print: (line: string) => void;

  constructor(o: MeterOptions = {}) {
    this.env = o.env ?? (() => process.env);
    this.now = o.now ?? (() => new Date());
    this.logPath = o.logPath ?? (() => this.env()["REAL_CALL_LOG"] || DEFAULT_CALL_LOG);
    this.print = o.print ?? ((l) => process.stderr.write(`${l}\n`));
  }

  /** Real requests made by this process so far. */
  get total(): number { return this.count; }

  /**
   * The cap on real requests, from REAL_CALL_CAP. Unset, empty, 0, negative or not a number all mean 0: real calls are off, so nothing can spend credits by accident.
   * There is no default; set it to the number of calls you accept, for example REAL_CALL_CAP=4.
   */
  get cap(): number {
    const n = Math.floor(Number(this.env()["REAL_CALL_CAP"]));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Called before a request is sent. When the request is allowed it is counted and its number is returned. When it is not (the cap is 0, or already reached) nothing is sent, nothing is
   * counted as a call, and the reason is returned in words a person can act on.
   */
  begin(node = "request"): { ok: true; n: number } | { ok: false; message: string } {
    this.printTotalAtExit();
    const cap = this.cap;
    if (cap === 0) {
      this.turnedAway++;
      return { ok: false, message: `Real model calls are switched off, so nothing was sent to Anthropic. Set REAL_CALL_CAP to the number of calls you accept (for example REAL_CALL_CAP=4) and run again. The call that was refused: ${node}.` };
    }
    if (this.count >= cap) {
      this.turnedAway++;
      return { ok: false, message: `The real model call cap is reached (REAL_CALL_CAP=${cap}, ${this.count} used), so nothing more was sent to Anthropic. The call that was refused: ${node}. Raise REAL_CALL_CAP to continue.` };
    }
    this.count++;
    return { ok: true, n: this.count };
  }

  /** Called when the request has ended, with the tokens the provider reported (0 when it failed before answering). */
  end(n: number, info: { node: string; model: string; input_tokens: number; output_tokens: number; outcome: "ok" | "error" }): void {
    const line: CallLogLine = { ts: this.now().toISOString(), n, node: info.node, model: info.model, input_tokens: info.input_tokens, output_tokens: info.output_tokens, outcome: info.outcome };
    try {
      const path = this.logPath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
    } catch (e) {
      // a log that cannot be written must never fail a film, but it should not be silent either
      if (!this.warned) { this.warned = true; this.print(`call log could not be written (${e instanceof Error ? e.message : String(e)}); calls are still counted`); }
    }
  }

  summary(): string {
    const cap = this.cap;
    return `Real model calls this run: ${this.count} (cap ${cap === 0 ? "off: REAL_CALL_CAP is not set" : cap}${this.turnedAway ? `, ${this.turnedAway} refused` : ""}). Log: ${this.logPath()}`;
  }

  /** Prints the total once, when the process ends, if a real call was made or refused. */
  private printTotalAtExit(): void {
    if (this.exitHook) return;
    this.exitHook = true;
    process.once("exit", () => { if (this.count > 0 || this.turnedAway > 0) this.print(this.summary()); });
  }

  /** Tests only. */
  reset(): void { this.count = 0; this.turnedAway = 0; this.warned = false; }
}

/** The one meter of this process. */
export const realCalls = new CallMeter();
