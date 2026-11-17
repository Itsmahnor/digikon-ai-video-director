import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@digikon/rag";

/**
 * Record and replay of real model responses, so a test or a script can reuse an answer instead of paying for it again.
 *
 *   LLM_FIXTURE_MODE=record   real requests run as usual (counted and capped) and each response is saved under the hash of the request
 *   LLM_FIXTURE_MODE=replay   responses are served from the saved files and the API is never called; a request with no fixture fails loudly
 *   (unset, empty or "off")   nothing changes
 *   LLM_FIXTURE_DIR           where fixtures live; default tests/fixtures/llm
 *
 * The key is a SHA-256 of everything that shapes the answer: model, system text, messages, tool schema, tool choice and token limit. Change the prompt and the hash changes,
 * so a stale fixture is never served for a different prompt; it is missing instead, and replay says so.
 */

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const DEFAULT_FIXTURE_DIR = join(repoRoot, "tests", "fixtures", "llm");

export type FixtureMode = "off" | "record" | "replay";

export function fixtureMode(env: Record<string, string | undefined> = process.env): FixtureMode {
  const v = (env["LLM_FIXTURE_MODE"] ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return "off";
  if (v === "record" || v === "replay") return v;
  // a typo must not quietly fall back to calling the API
  throw new Error(`LLM_FIXTURE_MODE is "${env["LLM_FIXTURE_MODE"]}". Use "record", "replay" or leave it unset.`);
}

export const fixtureDir = (env: Record<string, string | undefined> = process.env): string => resolve(env["LLM_FIXTURE_DIR"] || DEFAULT_FIXTURE_DIR);

/** What shapes a model's answer. The caller passes the request exactly as it would be sent. */
export interface PromptParts { model: string; max_tokens: number; system: unknown; messages: unknown; tools: unknown; tool_choice: unknown }

export const promptHash = (p: PromptParts): string => createHash("sha256").update(canonicalJson(p)).digest("hex");

export interface Fixture {
  format: "digikon.llm-fixture";
  /** SHA-256 of the request; also the file name. */
  hash: string;
  node: string;
  model: string;
  recorded_at: string;
  /** Enough to recognise the prompt by eye; the full prompt is not stored. */
  prompt: { system_chars: number; user_chars: number; user_head: string };
  response: { content: unknown[]; usage?: { input_tokens: number; output_tokens: number } };
}

const fileOf = (dir: string, hash: string) => join(dir, `${hash}.json`);

export function readFixture(dir: string, hash: string): Fixture | null {
  const file = fileOf(dir, hash);
  if (!existsSync(file)) return null;
  const f = JSON.parse(readFileSync(file, "utf8")) as Fixture;
  return f.format === "digikon.llm-fixture" && f.hash === hash && Array.isArray(f.response?.content) ? f : null;
}

export function writeFixture(dir: string, f: Fixture): string {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, f.hash);
  writeFileSync(file, `${JSON.stringify(f, null, 2)}\n`, "utf8");
  return file;
}

export const describePrompt = (system: unknown, messages: unknown): Fixture["prompt"] => {
  const first = Array.isArray(messages) ? (messages[0] as { content?: unknown } | undefined)?.content : undefined;
  const user = typeof first === "string" ? first : JSON.stringify(first ?? "");
  return { system_chars: typeof system === "string" ? system.length : JSON.stringify(system ?? "").length, user_chars: user.length, user_head: user.slice(0, 160) };
};

/** How many responses this process served from fixtures; printed once when it ends. */
export const fixtureStats = { replayed: 0, recorded: 0, hooked: false };
export function noteFixture(kind: "replayed" | "recorded", print: (l: string) => void = (l) => process.stderr.write(`${l}\n`)): void {
  fixtureStats[kind]++;
  if (fixtureStats.hooked) return;
  fixtureStats.hooked = true;
  process.once("exit", () => {
    if (fixtureStats.replayed) print(`Responses replayed from fixtures (no API calls): ${fixtureStats.replayed}`);
    if (fixtureStats.recorded) print(`Responses recorded to fixtures: ${fixtureStats.recorded}`);
  });
}
