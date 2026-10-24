# Editor skills (version 0.1.0)

Ten project-owned skills for the **Editor agent**, which turns an approved `DirectorHandoff` into a validated `EditorOutput`. First target: SaaS and product explainer videos. The index is [MANIFEST.json](MANIFEST.json); sources are in [REFERENCES.md](REFERENCES.md); the contracts are described in [docs/DIRECTOR_HANDOFF.md](../../docs/DIRECTOR_HANDOFF.md).

## Status: loaded by the Editor agent, offline-tested only
`runEditor` (`packages/director/src/editor-agent.ts`) reads this folder with `SkillLibrary`, puts the skills a job needs into its optional model review, and records their versions in the output's provenance. The deterministic part of the Editor (verification, operations, conflicts, execution report) does not depend on the model, and it is the part the tests cover. No live model has run these skills.

These are separate from the Director's own skills in `skills/` (`editing-director`, `motion-graphics`, `sound-design`, `video-qa`, and others), which make the plan the human approves. The Editor skills start after both approvals.

## Order of use
`core-contract` first and last; `safe-assets-and-tools` throughout; in between `footage-review`, `continuity-pacing`, `transitions-scene-assembly`, `captions-typography`, `audio-voiceover-mixing`, `motion-graphics-product-ui`, `final-video-qa`. `remotion-implementation` is documentation for the future renderer.

## Gaps against the actual contracts
- **G1 (closed in handoff 1.2.0).** Each recipe declares its `operation_type`, restricted by `RECIPE_OPERATIONS`, and `checkEditorOutput` enforces it.
- **G2.** No dialogue or accessibility captions: `caption.text` must equal the scene overlay, and the handoff holds neither word timings nor full transcripts. A scene with voiceover is reported as an `unsupported_operation` conflict.
- **G3.** No voiceover or TTS and no per-track audio controls. Audio assets can carry a user-recorded licence declaration (handoff 1.3.0); without one the Editor reports a conflict. `loudness-normalise` default (-16 LUFS) is a placeholder; no verified platform loudness target exists.
- **G4.** No vision pass: nothing can see what a clip shows.
- **G5.** All 19 recipes are `draft`; `implementation_ref` templates, a template registry and any renderer do not exist; Remotion is not installed. The Editor reports every operation as not executable until a `RendererRegistry` provides a template.
- **G6.** Target resolution and frame rate are not in the handoff. The Editor lists them under `execution.missing_inputs`; it invents no default.
- **G7.** Assets can be declared genuine product UI or not (handoff 1.3.0); the console has no control for it yet, so supplied screenshots are reported as undeclared. There is still no illustrative-UI recipe.
- **G8.** The Editor's knowledge is thin: no Editor-only notes, no verified platform specs, no approved examples.
- **G9.** The Remotion licence tier for the owner is undecided (see REFERENCES.md row 5).

## Schema versions
Handoff `1.3.0`, Editor `1.1.0`, as in `packages/contracts/src/{handoff,editor}.ts`.

## Not verified
Live Claude behaviour.
