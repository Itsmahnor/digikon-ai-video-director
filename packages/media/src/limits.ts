/** Upload rules. One place, so the console, the API and the tests agree. */
export const MEDIA_LIMITS = {
  maxVideoBytes: 1024 * 1024 * 1024,
  maxAudioBytes: 200 * 1024 * 1024,
  maxImageBytes: 25 * 1024 * 1024,
  /** A spoken prompt is a few sentences, not a podcast. */
  maxVoicePromptSeconds: 180,
  /** Longest video or audio asset accepted for a project. */
  maxAssetSeconds: 30 * 60,
  minDimension: 64,
  maxDimension: 8192,
  maxAssetsPerProject: 40,
} as const;

export const ALLOWED_EXTENSIONS = {
  video: [".mp4", ".mov", ".m4v", ".webm", ".mkv"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".webm"],
  image: [".png", ".jpg", ".jpeg", ".webp"],
} as const;

export const ALL_EXTENSIONS: readonly string[] = [
  ...new Set([...ALLOWED_EXTENSIONS.video, ...ALLOWED_EXTENSIONS.audio, ...ALLOWED_EXTENSIONS.image]),
];
