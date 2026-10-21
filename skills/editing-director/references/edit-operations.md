# Edit operations

An edit operation is always `{use_id, scene_id, recipe_id, params, rationale}`. The application compiles it to Remotion or FFmpeg; you never write code or filter strings.

Guidance (hypotheses until benchmarked):
- Most cuts should be hard cuts. Soft transitions are for mood changes.
- Match transition energy to the beat's energy: calm beat, crossfade; punchy beat, hard cut or wipe.
- Do not use the same decorative transition on every cut.
- A J-cut needs source footage with usable audio and a lead short enough to read as intent.
- High-energy recipes are usually limited per film; check max_uses_per_film.
