import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  version: string;
  body: string;
  dir: string;
}

/** Reads skills/<name>/SKILL.md. Only the body is sent to the model; references load on request. */
export function loadSkill(skillsDir: string, name: string): Skill {
  const dir = join(skillsDir, name);
  const raw = readFileSync(join(dir, "SKILL.md"), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`skill ${name}: SKILL.md needs frontmatter`);
  const meta = Object.fromEntries(
    m[1]!.split(/\r?\n/).map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (meta.name !== name) throw new Error(`skill ${name}: frontmatter name "${meta.name}" does not match folder`);
  if (!meta.description) throw new Error(`skill ${name}: description required`);
  return { name, description: meta.description, version: meta.version ?? "0.0.0", body: m[2]!.trim(), dir };
}

export function loadReference(skill: Skill, file: string): string {
  const p = join(skill.dir, "references", file);
  if (!existsSync(p)) throw new Error(`skill ${skill.name}: no reference ${file}`);
  return readFileSync(p, "utf8").trim();
}

/** Which skills apply at which step. Mirrors skills/video-director/references/routing.md. */
export const STEP_SKILLS = {
  intake: ["video-director"],
  treatment: ["commercial-strategy"],
  storyboard: ["commercial-strategy", "cinematography"],
  edit_plan: ["editing-director", "motion-graphics", "sound-design"],
} as const;
export type Step = keyof typeof STEP_SKILLS;

/**
 * Reference files each step needs, as "skill/file". They are appended to the system prompt, so a skill that says
 * "see references/x.md" is only ever shown that way when x.md really is in the prompt. A test enforces this.
 */
export const STEP_REFERENCES: Record<Step, readonly string[]> = {
  intake: [],
  treatment: ["commercial-strategy/structures.md", "commercial-strategy/claims-register.md"],
  storyboard: ["cinematography/footage-limits.md", "commercial-strategy/structures.md", "commercial-strategy/claims-register.md"],
  edit_plan: ["editing-director/edit-operations.md", "motion-graphics/safe-areas.md", "sound-design/loudness.md"],
};

export class SkillLibrary {
  private readonly cache = new Map<string, Skill>();
  constructor(private readonly dir: string) {}

  get(name: string): Skill {
    let s = this.cache.get(name);
    if (!s) { s = loadSkill(this.dir, name); this.cache.set(name, s); }
    return s;
  }

  /** System prompt for a step: the Director's own rules, only the skills routed to that step, and the references those skills rely on. */
  systemFor(step: Step): { system: string; skills: string[]; references: string[] } {
    const names = [...new Set(["video-director", ...STEP_SKILLS[step]])];
    const refs = STEP_REFERENCES[step].map((r) => {
      const [skill, file] = r.split("/") as [string, string];
      return { id: r, text: loadReference(this.get(skill), file) };
    });
    const bodies = names.map((n) => this.get(n).body).join("\n\n---\n\n");
    const refText = refs.map((r) => `### Reference: ${r.id}\n${r.text}`).join("\n\n");
    return { system: refText ? `${bodies}\n\n---\n\n${refText}` : bodies, skills: names, references: refs.map((r) => r.id) };
  }
}