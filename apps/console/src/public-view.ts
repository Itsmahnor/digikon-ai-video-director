import { PRODUCTION_REASON } from "@digikon/director";
import { SELECTION_BLOCKER_PREFIX } from "@digikon/render";
import type { ApprovalRecord, Escalation } from "@digikon/contracts";

/**
 * What the user is shown of DigiKon's internal production work. The plans, hashes, capability and engine choices, planner refusals and adapter errors stay in the server
 * log and the stored records; the user sees what DigiKon needs to do next, in ordinary words, and any genuine creative question as it was asked.
 */

/** The internal production implementation is not the user's business: approvals are shown without the binding and the production flag. */
export const publicApprovals = (records: readonly ApprovalRecord[]) => records.map(({ production_binding: _b, production_required: _r, ...r }) => r);

export const PLAIN_PRODUCTION = "The prepared plan no longer matches what was approved, so it has to be reviewed again before the video can be made.";
export const PLAIN_PLAN_CHANGED = "The prepared plan no longer matches what you approved, so the video was not made. Open the plan and review it again.";
export const PLAIN_CANNOT_PRODUCE = "This console can't make this video exactly as approved with the current output settings, so nothing was made. Try different output settings, or ask for changes to the plan.";
const PLAIN_UNPRODUCIBLE = "Part of this plan can't be produced with what is available on this computer right now.";

/** Production lines that are really about the creative plan, in the words a person can act on. Anything not recognised stays hidden behind the one general sentence above. */
const PLAIN_PRODUCTION_LINES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^production - (S\d+): its voiceover has (\d+) words, which does not fit (\d+(?:\.\d+)?)s when spoken/, (m) => `${m[1]}: the voice-over has ${m[2]} words, but the scene is only ${m[3]} seconds long. Shorten the voice-over or make the scene longer.`],
  [/^production - (S\d+): its voiceover needs a recording or a speech synthesiser/, (m) => `${m[1]}: the voice-over needs a recording or a speech voice, and this computer has neither. Upload a recording, or ask for no narration.`],
];
const plainLine = (line: string): string | null => { for (const [re, f] of PLAIN_PRODUCTION_LINES) { const m = re.exec(line); if (m) return f(m); } return null; };

/** Lines that describe internal production work rather than the creative plan. */
const INTERNAL = new RegExp(`^(production - |${PRODUCTION_REASON}|${SELECTION_BLOCKER_PREFIX})`);
export const isInternalReason = (r: string) => INTERNAL.test(r) || r.includes(PRODUCTION_REASON);

/** Reasons about the internal production plans are replaced by one sentence in ordinary words; the details stay in the server log, not on the screen. */
export function plainReasons(reasons: readonly string[]): string[] {
  const kept = reasons.filter((r) => !isInternalReason(r));
  if (kept.length === reasons.length) return [...reasons];
  console.error(`production (hidden from the user): ${reasons.filter(isInternalReason).join(" | ")}`);
  return [...kept, PLAIN_PRODUCTION];
}

/**
 * An escalation as the user sees it: creative and input problems stay exactly as written, internal production lines are replaced by one plain sentence (and logged).
 */
export function plainEscalation(e: Escalation | null | undefined): Escalation | null {
  if (!e) return null;
  const internal = e.evidence.filter(isInternalReason);
  if (!internal.length) return e;
  console.error(`escalation (production details hidden from the user): ${internal.join(" | ")}`);
  const translated = internal.map(plainLine).filter((x): x is string => x !== null);
  const hidden = internal.some((x) => plainLine(x) === null && !/pre-flight was not run because an earlier step is blocked/.test(x));
  return { ...e, evidence: [...e.evidence.filter((x) => !isInternalReason(x)), ...translated, ...(hidden || !translated.length ? [PLAIN_UNPRODUCIBLE] : [])] };
}
