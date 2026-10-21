# Footage limits

Asset notes per asset: `usable_segments` (time ranges), `quality_flags` (blur, shake, exposure, low_resolution, noise with time ranges), `content_summary` (only what is visible), `uncertain`, `transcript_ref`.

- Cropping or zooming costs resolution. As a starting hypothesis, keep total zoom within about 1.5x on 1080p source for a 1080p export; benchmark on real footage before treating it as a rule.
- A scene must lie fully inside one usable segment: source_in_seconds to source_in_seconds + duration.
- Still images can be reframed but have no motion of their own.
- If metadata is all you have (no visual inspection), say so in `uncertain`.

## What the notes contain, and what is measured

Everything below comes from measuring the file, not from guessing. It is reliable. What the footage *shows* is not yet known.

- `usable_segments`: the file with black and frozen stretches removed (pieces under half a second are dropped). A scene must fit inside one.
- `quality_flags` with `black_frames` or `frozen`: stretches that are not usable. A frozen stretch at the very end usually means the clip ends on a still frame.
- `quality_flags` with `silence`: quiet stretches (below -35 dB for half a second or more). Silence does not make footage unusable. It is a hint: a gap in speech is a natural place to cut, and a long silence under a shot may need music.
- `shots`: times where the picture cuts. More cuts means a busier source. A scene that spans a cut will show two different shots, so prefer scenes that start and end on a cut.
- `speech`: what was said and in which language. If it is present, the footage has a voice. Do not cut mid-sentence, and do not put on-screen text that contradicts what is said. If it is null the footage has no speech, or none was detected.
- `loudness_lufs`: how loud the audio track is. Very quiet or very loud sources need levelling in the final mix.
- `content_summary` is empty until a vision pass has looked at the footage, and `uncertain` says so. Never fill it in yourself and never describe what the footage "shows" beyond what the user told you.
