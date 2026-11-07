/**
 * What the brief says about sound, as a rule every later step obeys. A visual system comes with a habit of its own ("a slow score under the whole film"), but a person who writes
 * "narration only, no music" has decided, and the brief wins: the system's sound is never used against it. This is plain text reading, so it is repeatable and testable, and the same
 * rule is used in the Director's prompts and checks and in the audio plan the renderer carries out.
 *
 * It reads the brief text, which includes what the guided intake composes from its Sound choice ("Sound: narration (voice-over), no music."). Nothing is guessed: with no words about
 * sound, every kind is allowed and the system's own sound line stands.
 */
export interface SoundPolicy {
  /** A music bed or score. */
  music: boolean;
  /** Spoken narration (a voice-over). */
  narration: boolean;
  /** Sound effects and chimes. */
  effects: boolean;
}

export const ALL_SOUND: SoundPolicy = { music: true, narration: true, effects: true };

const SILENT = /\b(?:silent|no\s+(?:audio|sound)\b(?!\s+effects?)|without\s+(?:any\s+)?(?:audio|sound)\b(?!\s+effects?)|text\s+on\s+screen\s+only)/i;
const NO_MUSIC = /\b(?:no\s+(?:background\s+|backing\s+)?(?:music|score|soundtrack|music\s+bed)|without\s+(?:any\s+)?(?:background\s+)?(?:music|score|soundtrack)|music[-\s]free|narration\s+only|voice-?\s?over\s+only|only\s+(?:the\s+)?(?:narration|voice-?\s?over|voice))\b/i;
const NO_NARRATION = /\b(?:no\s+(?:narration|voice-?\s?overs?|narrator|spoken\s+words?)|without\s+(?:any\s+)?(?:narration|voice-?\s?overs?)|music\s+only|only\s+(?:the\s+)?music)\b/i;
const NO_EFFECTS = /\b(?:no\s+(?:sound\s+effects?|sfx)|without\s+(?:any\s+)?(?:sound\s+effects?|sfx)|narration\s+only|voice-?\s?over\s+only|music\s+only|only\s+(?:the\s+)?(?:narration|voice-?\s?over|voice|music))\b/i;

export function soundPolicyOf(text: string | null | undefined): SoundPolicy {
  const t = String(text ?? "");
  if (SILENT.test(t)) return { music: false, narration: false, effects: false };
  return { music: !NO_MUSIC.test(t), narration: !NO_NARRATION.test(t), effects: !NO_EFFECTS.test(t) };
}

export const restrictsSound = (p: SoundPolicy): boolean => !(p.music && p.narration && p.effects);

/** The policy in one plain sentence, for prompts and notes. Empty when nothing is ruled out. */
export function soundRuleText(p: SoundPolicy): string {
  if (!restrictsSound(p)) return "";
  if (!p.music && !p.narration) return "Sound: none. The film is silent and everything is carried by text on screen.";
  const out: string[] = [];
  if (!p.music) out.push("Sound is narration with silence between the lines and no music bed.");
  else if (!p.narration) out.push("Sound is music only, with no narration or voice-over.");
  if (!p.effects) out.push("No sound effects.");
  return out.join(" ");
}

/** The sound line of a visual system, replaced by the brief's rule when the brief restricts sound. The system's habit never overrides the brief. */
export function systemSoundFor(systemSound: string, p: SoundPolicy): string {
  const rule = soundRuleText(p);
  return rule ? `${rule} (This replaces the system's usual sound, "${systemSound}", because the brief decides.) Pacing is unchanged: hold titles and let the picture breathe.` : systemSound;
}

/** Words in a scene's audio cue that name music or an effect. They mirror what the audio plan treats as a music cue and as an effect cue (an effect word wins, as it does there). */
export const MUSIC_WORDS = /\b(?:music|bed|score|soundtrack|ambien\w*|pad|beat|melody|piano|strings|drone|underscore|song)\b/i;
export const EFFECT_WORDS = /\b(?:whoosh|swoosh|swish|sweep|riser|hit|impact|thud|boom|stinger|sting|chime|ding|bell|notification|click|tick|tap|pop|snap|sfx|sound\s+effects?)\b/i;

/** Problems in a scene plan's sound against the policy. Used as a generation-time check, so the model is sent back to fix them. */
export function soundPolicyIssues(scenes: readonly { scene_id: string; voiceover?: string | null; audio_cues: readonly string[] }[], p: SoundPolicy): string[] {
  if (!restrictsSound(p)) return [];
  const out: string[] = [];
  for (const s of scenes) {
    if (!p.narration && s.voiceover) out.push(`${s.scene_id}: sound_policy - the brief rules out narration, but this scene has a voiceover; remove it and carry the line as text on screen`);
    for (const cue of s.audio_cues) {
      if (EFFECT_WORDS.test(cue)) { if (!p.effects) out.push(`${s.scene_id}: sound_policy - the audio cue "${cue.slice(0, 60)}" is a sound effect, but the brief rules effects out`); }
      else if (!p.music && MUSIC_WORDS.test(cue)) out.push(`${s.scene_id}: sound_policy - the audio cue "${cue.slice(0, 60)}" is music, but the brief rules music out; ${p.narration ? "leave the narration with silence between the lines" : "plan no sound"}`);
    }
  }
  return out;
}
