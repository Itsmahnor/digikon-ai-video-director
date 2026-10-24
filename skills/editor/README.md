# Editor skills (version 0.1.0)

Ten project-owned skills for the future **Editor agent**, which turns an approved `DirectorHandoff` into a validated `EditorOutput`. First target: SaaS and product explainer videos. The index is [MANIFEST.json](MANIFEST.json); sources are in [REFERENCES.md](REFERENCES.md); the contracts are described in [docs/DIRECTOR_HANDOFF.md](../../docs/DIRECTOR_HANDOFF.md).

## Status: authored, not loaded
There is no Editor agent, orchestrator or prompt yet, so **nothing loads these skills at run time**. They are standalone, versioned instructions. The Director's `SkillLibrary` can read this folder unchanged (`new SkillLibrary("skills/editor")`), and one test keeps the manifest, the files and the schema versions in step.

These are separate from the Director's own skills in `skills/` (`editing-director`, `motion-graphics`, `sound-design`, `video-qa`, and others), which make the plan the human approves. The Editor skills start after both approvals.

## Order of use
`core-contract` first and last; `safe-assets-and-tools` throughout; in between `footage-review`, `continuity-pacing`, `transitions-scene-assembly`, `captions-typography`, `audio-voiceover-mixing`, `motion-graphics-product-ui`, `final-video-qa`. `remotion-implementation` is documentation for the future renderer.

## Gaps found against the actual contracts
- **G1.** No table maps a recipe type to an `operation_type` (`trim_clip`, `render_graphics_scene`, `overlay_text`, `concat`, `mix_audio`), and `checkEditorOutput` does not check it. Recommendation until one exists: `shot` and `camera_move` to `trim_clip`; `transition` to `concat`; `sound_cue` to `mix_audio`; text animations to `overlay_text`; `logo-reveal` and `end-card-cta` to `render_graphics_scene`.
- **G2.** No dialogue or accessibility captions: `caption.text` must equal the scene overlay, and the handoff holds neither word timings nor full transcripts.
- **G3.** No voiceover or TTS, per-track audio controls, or licence field on assets. `loudness-normalise` default (-16 LUFS) is a placeholder; no verified platform loudness target exists.
- **G4.** No vision pass: nothing can see what a clip shows.
- **G5.** All 19 recipes are `draft`; `implementation_ref` templates, a template registry and any renderer do not exist; Remotion is not installed.
- **G6.** Target resolution and frame rate are not in the handoff, but post-render QA needs them.
- **G7.** No illustrative-UI recipe or asset provenance flag.
- **G8.** The Editor's knowledge is thin: no Editor-only notes, no verified platform specs, no approved examples.
- **G9.** The Remotion licence tier for the owner is undecided (see REFERENCES.md row 5).

## Schema versions
Handoff `1.1.0`, Editor `1.0.0`, as in `packages/contracts/src/{handoff,editor}.ts`. The documentation previously said `1.0.0` for the handoff heading; the code was not changed.

## Not verified
Live Claude behaviour. No model has run any of these skills.
