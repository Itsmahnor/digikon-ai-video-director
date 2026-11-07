import type { ProjectKit } from "@digikon/contracts";

/**
 * The guided setup stores the user's answers in the project kit, but the router only read the text of the prompt box, so a Platform chosen in the form (Instagram Reels) could be
 * lost and the planner would ask again or fall back to YouTube 16:9. This adds the answers the text does not already say, as plain sentences, to what the router reads.
 * Only values the user provided or confirmed are used; nothing is invented, and nothing already in the text is repeated.
 */
export function kitContext(kit: ProjectKit | undefined, text: string): string {
  if (!kit) return "";
  const has = (v: string) => text.toLowerCase().includes(v.toLowerCase().replace(/[.\s]+$/, ""));
  const given = (f: { state: string; value?: unknown } | undefined): string | null => (f && f.state === "provided" && typeof f.value === "string" && f.value.trim() ? f.value.trim() : null);
  const out: string[] = [];
  const platform = given(kit.platform as never), audience = given(kit.audience as never), tone = given(kit.brand?.tone as never);
  if (platform && !has(platform)) out.push(`Platform: ${platform.replace(/[.\s]+$/, "")}.`);
  if (audience && !has(audience)) out.push(`Audience: ${audience.replace(/[.\s]+$/, "")}.`);
  if (tone && !has(tone)) out.push(`Tone of voice: ${tone.replace(/[.\s]+$/, "")}.`);
  return out.join(" ");
}
