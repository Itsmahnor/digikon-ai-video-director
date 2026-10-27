# Renderer foundation

Status: three renderers now exist (FFmpeg, Remotion, HyperFrames); see "Remotion and HyperFrames adapters" at the end for the current state. The sections before it describe the earlier FFmpeg-only stages and were checked on 2026-10-26; where they say Remotion or HyperFrames is absent, they are superseded.

## What exists and what does not

| Item | State |
|---|---|
| `Renderer` enum (`packages/contracts/src/recipe.ts`) | `remotion`, `ffmpeg`, `hyperframes`. |
| `RendererRegistry` (`packages/director/src/editor-agent.ts`) | An interface with one method, `template(ref)`. The only implementation is `NO_RENDERERS`. |
| Recipes | 19, all `draft`, none with a review record. 10 name a `remotion/` template, 9 an `ffmpeg/` template. No template behind any of them exists. |
| Remotion | (Superseded: installed and integrated, see the last section.) Was: not installed, not in any `package.json`. `skills/editor/remotion-implementation` documents rules only. |
| HyperFrames | (Superseded: installed and integrated, see the last section.) Was: not installed, no code, no documentation beyond "stays a stub until verified" in `docs/PROJECT_DISCOVERY.md`. Its capabilities are unverified. |
| FFmpeg 9.0.2 | On PATH. Already used by `packages/media` (probe, black/freeze/silence/loudness analysis). |
| QA | `packages/qa` `runTechnicalChecks` measures a rendered file (duration, size, fps, audio, black/frozen frames, loudness). Not wired to any render yet. |
| Persistence | `RunStore` (`packages/director/src/store.ts`) stores approvals, checkpoints and the handoff. Nothing stores render results. The console does not call the Editor. |

## Rendering contract (`packages/contracts/src/render.ts`, `RENDER_SCHEMA_VERSION` 1.0.0)

`RenderSettings` (every field required, no defaults): `aspect_ratio` (`16:9`, `9:16`, `1:1`), `width`, `height`, `fps`, `duration_s`, `container` (`mp4`, `mov`, `webm`), `video_codec` (`h264`, `h265`, `vp9`, `prores`), `audio_codec` (`aac`, `mp3`, `opus`, `pcm_s16le`, or `null` for no audio), and `source` (`user_approved` or `verified_documentation`, plus a reference).

Rules enforced: size matches the aspect ratio (1% tolerance); even sides for h264/h265; the container can carry the codecs (mp4: h264/h265 with aac/mp3; mov: h264/h265/prores with aac/pcm; webm: vp9 with opus). These are format rules, **not platform specifications**. No platform preset, frame rate or resolution is assumed anywhere.

`RenderRecord` states: `planning` (blockers listed), `executable`, `rendering`, `rendered`, `failed`. The schema makes `rendered` impossible without a measured `output` (path, bytes, SHA-256, container, size, fps, duration, codecs, audio tracks, checks) that matches the settings, and makes `output` impossible in any other state.

## Foundation (`packages/render`)

- `planRender` re-parses the handoff and the Editor output, re-runs `checkHandoff` (or `verifyHandoffWithStore`) and the Director's `checkEditorOutput`, requires status `ready`, then recomputes executability from the adapters that really exist (the Editor's own report is not trusted). Failing input is rejected with no record. Otherwise the result is a `planning` or `executable` record.
- Production needs reviewed recipes and a production-ready handoff. A `preview` may use draft recipes, is labelled so, and never marks a recipe reviewed.
- `executeRender` runs an adapter, then probes the file with ffprobe. It refuses a pre-existing output file, enforces a timeout and abort signal, and ends in `rendered` only for a file that matches the settings.
- `AdapterRegistry` is also the Editor's `RendererRegistry`. `RenderAdapter` is the only place renderer-specific code may live.
- `saveRenderRecord` / `loadRenderRecord`: one JSON file per render, atomic write, re-validated on load.
- Not built: composing two renderers in one video. A plan whose operations need both Remotion and FFmpeg stays in `planning` with a blocker. Today's six-operation example plan needs both.

## Remotion and HyperFrames

- **Remotion** suits the graphics-led recipes (text, end card, logo, lower third, camera moves on footage). Facts recorded in `skills/editor/remotion-implementation` (read from remotion.dev on 2026-10-24, not re-verified here): browser-based React rendering, `staticFile()` assets, `@remotion/captions`. Not installed; not integrated.
- **HyperFrames** is a candidate for the later bulk-footage workflow. Nothing about it is verified, so no adapter, stub or enum value was added.
- FFmpeg is verified locally and covers 9 recipes by name, but no template for any of them exists either.

## Open decisions (yours)

1. **Remotion licence.** The skill note records that it is free only for individuals, companies of up to 3 employees and non-profits, and otherwise needs a company licence. This must be checked against Digikon's situation and the current terms before installing. No tier was chosen.
2. **Install Remotion?** It needs a dependency and a headless browser download. Not done.
3. **HyperFrames.** Source, licence and capabilities must be reviewed before an adapter is written.
4. **Output settings.** Which resolution, frame rate, container and codecs you approve, per platform. Verified platform specs exist only as retrieved text, not fields.
5. **Whether `package-lock.json` / `npm install` may be run** so `@digikon/render` is linked as a workspace. It currently resolves only inside its own folder.

## Audio and asset gaps (minimum changes)

- **Voiceover.** Scenes carry the spoken text, but no recipe or operation produces audio from it, so the Editor reports an `unsupported_operation` conflict and the render is refused. Needs: a voiceover asset role (recorded file, or a text-to-speech decision; `packages/speech` is speech-to-text only) and an operation that places it.
- **Asset role.** `Asset` has `media_type: audio` but no role (voiceover, music, sound effect). Needed to mix correctly and to avoid ducking the wrong track.
- **Licensing.** `AssetLicense` is `user_owned | licensed | unknown` with a note. The Editor enforces it for audio only. Missing: licence source or proof, attribution requirement, and the same check for images, logos and footage. No licence is ever inferred.
- **Captions.** Overlay text is placed by text recipes. There is no subtitle file (SRT/VTT) output and no word-timed captions from a transcript, though transcripts exist for uploads.
- **Sound effects and music.** Draft recipes `sfx-hit-on-cut` and `music-bed-duck` exist; neither has an asset role to take its input from.
- **Loudness.** The handoff's `loudness_target_lufs` is null until a verified platform spec supplies one.
- **Genuine product UI.** `genuine_product_ui` (true/false/null) exists and the Editor blocks when it is undeclared for a supplied screenshot. Missing: capture provenance (what, when, which app version). Logos have no genuineness or licence check.

## Remaining blockers before a real end-to-end render

1. An approved Remotion decision (licence, install) and at least one real, test-rendered template, and/or an FFmpeg template for the recipes that name one.
2. A reviewed recipe with a review record (evidence = a real test render), or the work stays preview-only.
3. A way to compose Remotion and FFmpeg output, or plans limited to one renderer.
4. User-approved output settings.
5. Audio asset role, licensing fields and a voiceover path, if any plan has voiceover or sound.
6. Wiring `packages/qa` to the rendered output, and the console to the Editor and renderer.

## First real rendering path (FFmpeg)

- Adapter: `packages/render/src/ffmpeg.ts`. One template, `ffmpeg/text-card`, for `render_graphics_scene` operations only: a solid colour, an accent bar and the approved text fading in, scenes joined in order. Everything else (other operations, templates, assets, audio cues, containers, codecs, audio, timeline gaps, non-whole-frame scenes, unknown or out-of-range parameters, control characters in text) is refused before FFmpeg starts.
- Recipe: `recipes/animation/text-card-fade.json`, a new recipe that stays `draft` with no review record. No existing recipe was changed or reviewed.
- Safety: FFmpeg runs through an argument array with no shell, the text is read from a temp file with expansion off (it never enters the filter graph), the output path must be a render file inside the output folder, the job's abort signal stops FFmpeg, and a failed or stopped run removes its output.
- Evidence: `packages/render/src/evidence.ts` writes a per-recipe evidence file from a rendered record plus QA results. It does not review anything. Run the tests with `RENDER_PROOF_DIR` set to keep the evidence and sample frames (for example `storage/test-renders`).
- Workspace: `@digikon/render` is linked (junction plus lockfile entries; `npm ci --dry-run` accepts the lockfile). No packages were installed.

## Console integration (preview workflow)

Flow, all in the existing console (`apps/console/src/app.ts`, `render-service.ts`, `public/app.js`): route, Director run, **storyboard approval**, edit plan, **edit-plan approval**, `POST /editor` (rebuilds and re-verifies the handoff against the stored approvals and files, then runs the Editor with no model call), `GET /render` and `POST /render/plan` (render plan: supported and unsupported operations, per-scene coverage, blockers, preview and production readiness shown separately), `POST /render` (preview only), `GET /renders`, and a video route that serves only a record that says rendered whose file is inside the run's render folder and still matches its recorded size and SHA-256.

- A preview is allowed only when `planRender` is executable **and** every approved scene is fully shown (`packages/render/src/coverage.ts`). Footage, images, logos, product screens, voiceover, audio cues and transitions make a scene "not fully shown", so those plans are refused with the exact reasons and nothing is rendered.
- Output settings are never filled in by the console. Width, height and frame rate are typed by the user (a labelled "test values" button fills 640 x 360 at 30 fps on request). Aspect ratio and duration come from the approved plan; the container and codec are the only ones the adapter writes.
- The Editor result is stored per run, bound to the handoff hash. A changed plan, new run, damaged file or missing approvals refuses the render.
- Files live under `storage/sessions/<id>/renders/<run>/` (`out/`, `records/`, `evidence/`, `editor-output.json`). Errors shown to the user have absolute paths removed, and an invalid or failed output file is deleted.

## Expanded scene templates (FFmpeg)

All in `packages/render/src/ffmpeg.ts`; each has a draft recipe in `recipes/animation/` (and the existing `crossfade` recipe is now implemented). Every visible word comes from the scene's approved overlay text; layouts that show sections read them from that text, separated by `|`, so nothing is added, reworded or taken from unreviewed recipe parameters.

| Template | Recipe | Overlay text format | Notes |
|---|---|---|---|
| `ffmpeg/text-card` | `text-card-fade` | whole text | |
| `ffmpeg/title-subtitle` | `title-subtitle` | `Title \| Subtitle` (subtitle optional) | |
| `ffmpeg/bullet-list` | `bullet-list` | `Heading \| Item \| Item ...` (2 to 5 items, one line each) | items appear one after another |
| `ffmpeg/stat-callout` | `stat-callout` | `Figure \| Label \| Context` (context optional) | a figure is a claim: it needs an approved fact |
| `ffmpeg/image-scene` | `image-scene` | caption (whole text) | one supplied image; contain or cover; optional slow zoom; shown labelled "Concept illustration" when a product screen was not declared a genuine capture |
| `ffmpeg/xfade-fade` | `crossfade` (existing) | none | blends the end of a scene into the first picture of the next; the film keeps its length |

Text that does not fit its space, a list that overflows, an unsupported layout, a timeline gap, a non-whole-frame duration or an unusable image is refused. The adapter reports these while planning (`RenderAdapter.check`), so they appear as blockers, not render-time failures. Coverage (`previewCoverage`) is now capability-aware: a scene is shown only if an operation that can render it carries its text, its supplied image and its transition. Still refused: video clips, audio, voiceover, logos or screens that were not supplied (placeholders), and the dip-to-black, wipe and match-cut transitions.
## Supplied video clips (FFmpeg)

Template `ffmpeg/clip-play`, for `trim_clip` operations, with two draft recipes in `recipes/shot/`: `clip-play` (the clip alone) and `clip-play-caption` (the scene's overlay text as a caption on a translucent strip). Nothing else about video is claimed.

**What a clip operation does:** plays one supplied video from the storyboard's approved `source_in_seconds`, at normal speed, for exactly the scene's duration, fitted to the output frame (`contain` letterboxes onto a chosen colour, `cover` crops), with no audio. Frame rate is converted to the output rate by repeating or dropping frames. The caption is the approved overlay text and nothing else.

**Checked before FFmpeg runs (planning blockers, per operation):** exactly one asset that is a video (an image, audio or any other media is never substituted); an absolute path to a .mp4, .m4v, .mov, .webm or .mkv file that exists and is not empty; the approved start point is present and not negative; the trim end does not pass the end of the clip; the file is measured again with ffprobe and must still match what was analysed and approved (frame size, number of audio tracks, length within 0.25 s) and must have a usable frame rate and duration; scene timing is contiguous, in order and whole frames; parameters and caption text are valid and fit.

**Sound:** a clip with an audio track is blocked unless every operation that plays it carries `source_audio: drop` in the approved edit plan. The default is `keep`, so dropping sound is always a visible, approved choice, and the render record notes it. Audio itself is still not produced.

**Also blocked (coverage, with the scene named):** a storyboard shot with camera motion on supplied media (the clip is played unchanged and no camera-move template exists), footage that no operation plays, transitions other than the crossfade, voiceover, audio cues, and any recipe without a template (for example `static-hold`, `slow-push-in`).

**Where checks live:** the adapter's `check` hook (during `planRender`), `previewCoverage` (capability-aware, used by the console for preview eligibility), the handoff check (clip bytes changed after approval), and `executeRender`'s own re-check of asset files immediately before rendering.

No camera footage exists on the development machine; the tests use generated clips with continuous motion in different sizes, frame rates, containers and shapes (one with sound). Set `RENDER_REAL_CLIP` to a video file of your own to render it as well.
## Remotion and HyperFrames adapters

Verified on 2026-10-27 on the development machine (Windows 10, Node 24.21.0, npm 11.19.0, FFmpeg 9.0.2, Chrome 155 and Edge 155 already installed). Both are real backends behind the existing `RenderAdapter` and `AdapterRegistry`; there is no parallel render path.

### Dependencies (`packages/render`, exact versions, installed with `--ignore-scripts`, nothing downloaded)

`remotion`, `@remotion/bundler`, `@remotion/renderer` 4.0.539; `react`, `react-dom` 19.3.1; `hyperframes` 0.8.207 (the official CLI package, Apache-2.0). `@hyperframes/producer` was not used: the CLI package declares its licence and is the documented local render path; the producer package's npm metadata has no licence field. GSAP was not installed (its licence is a "no charge" licence, not an open-source one; the compositions use CSS keyframes instead). No CDN is used: the font and images are copied next to the composition.

### Registration and invocation

- `packages/contracts/src/recipe.ts`: `Renderer` now includes `hyperframes`.
- `packages/render/src/web-scenes.ts`: the checks both browser renderers share (`planWebScenes`). It runs while planning, through each adapter's `check` hook, so an unsupported operation is a blocker naming its operation instead of a render-time failure.
- `packages/render/src/remotion.ts` (`createRemotionAdapter`): copies the font and supplied images into a temporary `public` folder, bundles the fixed React composition in `packages/render/remotion-project/` with `@remotion/bundler`, measures the composition with `selectComposition` (size, fps and frame count must equal the approved values), then renders h264 with `renderMedia` on this machine. No Lambda, no licence key.
- `packages/render/src/hyperframes.ts` (`createHyperframesAdapter`): writes one HTML composition (CSS keyframe animation, escaped approved text, `data-start`/`data-duration` from whole frames) plus the font and images to a temporary folder and runs `node node_modules/hyperframes/bin/hyperframes.mjs render … --format mp4 --fps N --workers 1 --strict` with an argument array (no shell), with telemetry and update checks switched off and `HYPERFRAMES_BROWSER_PATH` set to the installed Chrome.
- `packages/render/src/verify.ts` (`verifySceneContent`): after either browser renderer finishes, the last frame of every approved scene is read back and must show more than its background colour. A blank scene fails the render and removes the output. This exists because a file can have the right size, length and codec and still be empty.
- `packages/render/src/select.ts` (`selectRenderer`): the renderer is read from the approved edit plan (each recipe names a template, each template belongs to one renderer, only a registered adapter counts). It reports the selected renderer, every renderer needed, plans that would need two, and the operations nobody can run. Coverage is judged against the selected renderer's own capabilities.
- Console (`apps/console/src/app.ts`, `public/app.js`): the registry holds every adapter that can be built on the machine; the plan view shows the selected and the available renderers; coverage uses the selected renderer's capabilities. Behaviour for FFmpeg plans is unchanged.
- Recipes (all `draft`, none reviewed, none promoted): `text-slide-remotion` (`remotion/text-slide`), `image-caption-remotion` (`remotion/image-caption`), `text-fade-hyperframes` (`hyperframes/text-fade`), `image-caption-hyperframes` (`hyperframes/image-caption`). The existing `remotion/*` recipes (`text-fade-up`, `lower-third-slide`, …) still have no template and are still reported as unsupported.

### What both renderers can and cannot do

Supported: `render_graphics_scene` operations only; a text scene (approved text over a solid colour with an accent bar, animated in) and an image scene (one supplied image, `contain`/`cover`, optional `slow_zoom`, the approved caption, and the "Concept illustration" label for a product screen not declared genuine). Output mp4 / h264 / no audio only. Scenes must be contiguous, in order and whole frames.

Refused before rendering, naming the operation: transitions (every `concat`, including the crossfade), trim/clip operations and supplied video, camera moves, overlays other than the above, audio cues and any audio track, other containers or codecs, parameters outside the recipe's range, text that does not fit or has control characters, assets of the wrong type or missing, assets nothing shows. The console's coverage check additionally refuses a scene whose approved transition, camera motion, voiceover or required logo/footage the renderer cannot show.

Combining renderers in one video is **not built**: a plan whose operations need two renderers stays in `planning` with the blocker "the operations need more than one renderer", and nothing is rendered or substituted. Production renders stay blocked for every draft recipe, as before.

### Browser

Neither adapter downloads a browser. HyperFrames uses the Chrome found by `findChrome`. Remotion uses `selectRemotionBrowser`, which refuses a 32-bit browser (see "Render safety and validation hardening" below). Earlier text here that said the cause of the blank Remotion scenes in Chrome was not found is superseded.

### Licensing concerns, deferred for review (not cleared)

- **Remotion** is source-available under its own licence, not open source. Free for individuals and companies of up to three people; companies of four or more need a paid Company licence (the licensing page listed it from $100 per month at the lowest tier). Whether Digikon qualifies, and whether use inside a product that renders for others counts as "automation", has not been decided. The full LICENSE.md was not read. `npm audit` also reports advisories in Remotion's studio dependencies; the studio is not used.
- **HyperFrames** is Apache-2.0 (declared by the npm package and the repository). It is version 0.8.x, so its interface may change. The CLI can contact a version-check service and send anonymous usage telemetry unless disabled; the adapter disables both with environment variables, which was not independently confirmed by watching network traffic.
- **GSAP** (not installed) uses a non-OSI "no charge" licence; revisit before adding it.
- The font file is a system font (Arial) supplied by the machine; its redistribution terms are not Digikon's to assume.

## Render safety and validation hardening

Added 2026-10-27 after a read-only audit. No dependency was installed and no network call was made. All recipes are still `draft`; production rendering is still blocked.

### Browser selection (Remotion)

- **Confirmed cause of the blank Remotion scenes:** Remotion 4.0.539 always starts its browser with `--force-gpu-mem-available-mb=4096` (`@remotion/renderer/dist/open-browser.js`; not configurable). With that flag the 32-bit Chrome 155 on the development machine (`Program Files (x86)`, PE machine 0x14c) paints only each element's own background and none of its children. Reproduced on a bare page: 1024 to 3000 paint correctly, 4096 does not; the 64-bit Edge paints correctly with the same flag. **Not proven:** why 4096 matters (it equals 2^32 bytes, which would wrap in 32-bit arithmetic).
- `packages/render/src/browser.ts`: `inspectBrowser` reads the executable header (Windows PE or Linux ELF) and reports 32-bit or 64-bit; `selectRemotionBrowser` / `selectRemotionBrowserFrom` pick the first compatible installed browser in the order explicit path, `DIGIKON_REMOTION_BROWSER`, Edge, Chrome, and keep a record of every browser looked at and why it was refused. A 32-bit browser is refused even when named explicitly. If none is compatible the adapter refuses to start and lists them; nothing is downloaded. On macOS the word size cannot be read from the file, so a browser there is accepted unchecked and the content check below is the only guard.
- `createRemotionAdapter` records the browser used on the render record's notes. `unsafeAllowIncompatibleBrowser` exists for tests only, to prove the content check still catches a blank render.
- Evidence on this machine: `selectRemotionBrowser()` returns Edge (`msedge.exe`, 64-bit); Chrome in `Program Files (x86)` was inspected as 32-bit and is not used by Remotion. HyperFrames still uses that Chrome, where it renders correctly.

### Coverage is enforced by the renderer layer

- `planRender` now runs the same coverage check the console showed (`previewCoverage`, with the capabilities of the selected renderer) and turns every gap into a blocker of the form `S02: <what is not carried out>`, for previews and for production. The console, the library and any other caller therefore get the same refusal. Added rules: camera motion on any scene (not only scenes with media); a caption timed differently from its scene.
- `executeRender` no longer trusts the plan it is given. Before any record says "rendering" it re-checks: blockers on the record, each operation against the adapter's own templates and renderer, the adapter's `check`, and coverage recomputed from the handoff and Editor result carried on the plan (`ExecutablePlan.handoff` / `editor_output`). A failing plan returns a `failed` record with stage `precheck` and the adapter is never started.
- Approved details that no renderer here changes or checks are no longer silent: they are written to the record's `notes` (text placement and safe area, shot size, visual action). They are not blockers because they describe content, but they are not verified either.
- Still unsupported and blocked: transitions in Remotion/HyperFrames, camera moves, shot-size or visual-action changes, supplied video in Remotion/HyperFrames, audio, voiceover, music, logos and screens that were not supplied, and mixed-renderer plans.

### Scene-content verification (`packages/render/src/verify.ts`)

After Remotion or HyperFrames renders, `verifySceneFidelity` reads the last frame of every scene and checks: the background colour; the approved text against a reference drawn by FFmpeg from the same font file (ink area, centre, position, line width, and for one-line text of 28 px or more the outline of the glyphs); the accent bar; the supplied image against a reference scaling of its file (colour, and layout when the picture has structure) at the approved fit and zoom; and the concept label when required. A failure fails the render and deletes the file. The record's notes list what the checks cannot establish.

**Limitations, stated, not hidden:** this is pixel comparison, not OCR; only the last frame of each scene is compared; a different word with an almost identical outline, or a one-letter change, can pass (measured: a one-letter change was caught in one of three test scenes); caption-size text (under 28 px) is matched on ink area, position and width only; multi-line text has no outline match; a flat-colour image is matched by colour only. Exact content fidelity is therefore not claimed.

### Tests

- `CI=1` (or `RENDER_TESTS_REQUIRE_REAL=1`) makes missing prerequisites (font, Chrome, a 64-bit browser for Remotion) a failing test instead of a skip; `RENDER_TESTS_ALLOW_SKIP=1` restores the skip for a local environment configured on purpose. See `packages/render/src/test-env.ts`.
- `packages/render/src/hardening.test.ts`: browser selection (fake PE and ELF headers and the real browsers), the Chrome defect as a regression test (skipped visibly where no 32-bit Chrome is installed), the content check catching a blank Remotion render in the 32-bit Chrome, planner and `executeRender` refusals, and verification against real HyperFrames renders (wrong text, swapped scenes, wrong colours, blank or short films, wrong or flipped image, missing concept label).
- Recipe-count assertions now compare the loaded library with the recipe files on disk. The upload-analysis test in `apps/console/src/app.test.ts` has a 30 s timeout (it ran real ffmpeg under the 5 s default).
- Several older fixtures asked for scenes the renderer could not show (placeholder logos, unrendered transitions, delayed captions) and relied on `planRender` accepting them. They now use fully covered plans, and three assertions that expected `executable` for an incomplete plan now expect `planning` with the exact blocker.

### HyperFrames network status (unchanged by this milestone)

Verified in the installed code: telemetry is disabled by `HYPERFRAMES_NO_TELEMETRY` or `DO_NOT_TRACK`; the npm update check is skipped by `HYPERFRAMES_NO_UPDATE_CHECK=1`, `CI=1` and when stderr is not a terminal; the adapter sets all of these. **Not verified, and not claimed:** that a render makes no network request. Open questions: (1) the compiler can inject Google Fonts links for font families it does not recognise (`chunk-7RWUY3BJ.js`); our compositions declare `DigikonFont, sans-serif`, and no font cache appeared in `~/.cache/hyperframes` after many renders, but that is indirect evidence only; (2) each render writes a history record under `~/.cache/hyperframes/history/` outside the repository, which is not cleaned up by this project. Settling (1) needs a network capture, which has not been approved.