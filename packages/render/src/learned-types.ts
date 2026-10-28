/**
 * A transition that a learned capability adds to the FFmpeg adapter. It is data for the crossfade engine, which blends the end of one scene
 * into the first picture of the next with FFmpeg's `xfade` filter: either one fixed xfade transition, or one chosen from the operation's
 * `direction` parameter. It carries no code and no filter text; the engine builds the filter graph from the validated name.
 */
export interface LearnedTransition {
  /** The template reference a recipe names, for example `ffmpeg/xfade-fadeblack`. */
  template: string;
  /** The storyboard transition this template carries out (`dip_to_black`, `wipe`), so coverage can tell an approved transition is rendered. */
  storyboard_transition: string;
  /** The fixed xfade transition name, or null when `direction_map` chooses it. */
  xfade: string | null;
  /** Maps the `direction` parameter to an xfade name, or null. */
  direction_map: Record<string, string> | null;
}
