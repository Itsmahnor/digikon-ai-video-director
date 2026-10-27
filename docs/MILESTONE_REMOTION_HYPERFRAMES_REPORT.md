# Milestone report: Remotion and HyperFrames integration

Date: 2026-10-27. Branch `feature/two-approval-gates`. Nothing was committed.

## 1. Dependencies installed (workspace `@digikon/render`, exact versions, `--ignore-scripts`)

| Package | Version | Licence metadata |
|---|---|---|
| remotion, @remotion/bundler, @remotion/renderer | 4.0.539 | "SEE LICENSE IN LICENSE.md" (source-available) |
| react, react-dom | 19.3.1 | MIT |
| hyperframes (official CLI package) | 0.8.207 | Apache-2.0 |

About 231 packages were added transitively; `package-lock.json` changed. `@hyperframes/producer` was **not** used (its npm metadata has no licence field; the CLI package declares one and is the documented local render path). `gsap` was **not** installed (non-OSI "no charge" licence; CSS keyframes are used instead). No CDN is used.

## 2. Licensing concerns deferred for your review (not cleared)

- Remotion: free for individuals and companies of up to 3 people; companies of 4 or more need a paid Company licence (listed from $100/month at the lowest tier on the licensing page). Whether Digikon qualifies, and whether rendering for others counts as "automation", is undecided. LICENSE.md was not read in full. `npm audit` lists advisories in Remotion's studio dependencies (the studio is unused) plus existing ones in vitest and zod.
- HyperFrames: Apache-2.0, version 0.8.x so its interface may change. Telemetry and update checks are switched off by environment variables; that was not confirmed by watching network traffic. (`hyperframes doctor` run once during the audit did a version check.)
- GSAP (not installed) has a non-OSI licence; the system font Arial is machine-supplied.

## 3. Browser requirements and downloads

**No download occurred.** Chrome 155 (`Program Files (x86)`) and Edge 155 were already installed.
- HyperFrames uses that Chrome.
- Remotion 4.0.539 paints only each scene's background in this Chrome 155 (every `chromeMode` / GL combination tried), but renders fully in the installed Edge 155. The adapter therefore prefers Edge, then Chrome, in Remotion's `chrome-for-testing` mode. The cause in Chrome was not found. A blank-scene content check turns this failure into an explicit error on any machine.

## 4. Files changed

- `packages/contracts/src/recipe.ts`: `Renderer` gains `hyperframes`.
- `packages/render/src/web-scenes.ts`: shared planning/validation for both browser renderers.
- `packages/render/src/remotion.ts`, `packages/render/remotion-project/{index,Scenes}.jsx`: Remotion adapter and React composition.
- `packages/render/src/hyperframes.ts`: HyperFrames adapter and HTML composition builder.
- `packages/render/src/verify.ts`: per-scene content check on the finished file.
- `packages/render/src/select.ts`: renderer selection and capabilities; `adapter.ts` gains `renderers()` and `templateRefs()`; `browser.ts`: browser discovery and process runner; `index.ts` exports.
- `recipes/animation/`: four new draft recipes (`text-slide-remotion`, `image-caption-remotion`, `text-fade-hyperframes`, `image-caption-hyperframes`).
- `apps/console/src/app.ts`, `public/app.js`: registry holds every buildable adapter; plan view and coverage use the selected renderer; minimal text change in the render panel.
- Tests: `packages/render/src/web-renderers.test.ts` (100 tests), `apps/console/src/render-web.test.ts` (7 tests). Existing tests were not removed or loosened; six assertions of the total recipe count were updated from 26 to 30 for the four new recipes.
- Docs: `docs/RENDERER_FOUNDATION.md` (new final section), this report.

## 5. Results

| | Baseline (before) | Final |
|---|---|---|
| Test files / tests | 34 / 591 passed | 36 / 702 passed |
| Typecheck | 0 errors | 0 errors |
| Evals | 16/16 | 16/16 |

One full-suite run failed `app.test.ts` "checks the uploaded files on disk" (an existing ffmpeg-timing test the file itself notes can pass 5 s under load); it passed alone and in the next full run. Treat it as a load-sensitive existing test.

## 6. Real render evidence (files kept in `storage/test-renders/web/`, git-ignored)

All four are real files rendered locally, measured with ffprobe, passed the QA package, and were read back frame by frame (scene order, exact scene boundaries, background colours, text fading in, supplied image shown, concept label only on the undeclared product screen).

| File | Renderer | Metadata |
|---|---|---|
| `T-remotion.mp4` | Remotion | 3 text scenes, mp4 h264, 640x360, 30 fps, 9 s, no audio, 75,103 bytes |
| `I-remotion.mp4` | Remotion | text + supplied image (cover, slow zoom) + concept screen, 360x640, 30 fps, 10 s, 70,771 bytes |
| `T-hyperframes.mp4` | HyperFrames | same text film, 640x360, 30 fps, 9 s, 75,030 bytes |
| `I-hyperframes.mp4` | HyperFrames | same image film, 360x640, 30 fps, 10 s, 59,624 bytes |

Contact sheets (`*-sheet.png`) and per-recipe evidence JSON sit beside them. Console end to end (approvals, Editor, plan, render, QA, verified playback): Remotion 12 s film, 77,280 bytes; HyperFrames 12 s film, 64,248 bytes; FFmpeg plan unchanged. Small colour differences exist (HyperFrames background up to 3 levels darker than specified); tests allow 14.

## 7. Unsupported features and remaining blockers

- Both new renderers: `render_graphics_scene` only; mp4/h264/no audio only. Not built: transitions (including crossfade), video clips, camera moves, lower thirds, logos, audio, voiceover, music. The existing `remotion/text-fade-up` and other `remotion/*` recipes still have no template and are reported unsupported.
- Mixing renderers in one video is not built; such a plan stays in `planning` with the blocker "the operations need more than one renderer".
- Production remains blocked: every recipe is still draft with no review record.
- Open: Remotion licence decision; why Remotion paints nothing in this Chrome; confirming HyperFrames sends nothing over the network.

## 8. Confirmations

No commits were made. No paid or live API calls, and no cloud rendering, were used. Installs were made only after your approval, and no browser or other download occurred.
