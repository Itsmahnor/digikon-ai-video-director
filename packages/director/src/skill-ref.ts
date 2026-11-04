import type { SkillLibrary } from "./skills.js";

/** What the provenance record says about a skill the library does not hold (for example a skills-collection id such as a video-type playbook). */
export const UNKNOWN_SKILL_VERSION = "unknown";

/**
 * "name@version" for the audit record and the handoff. A skill the SkillLibrary has is recorded with its real version. A name it does not have is recorded as
 * `name@unknown`: an explicit marker that no version is known, never an invented one.
 */
export function skillRef(skills: Pick<SkillLibrary, "get">, name: string): string {
  try { return `${name}@${skills.get(name).version}`; } catch { return `${name}@${UNKNOWN_SKILL_VERSION}`; }
}
