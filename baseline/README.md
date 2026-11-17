# Baseline: what the system makes today

Taken 2026-11-17 and 2026-11-18, before any creative, schema or drawing change. Use it to compare later builds (see `rubric.md`).

## State when it was taken

| | |
|---|---|
| Branch | `feature/m1-capability-registry-v2` |
| Commit | `5da1b720573ea4b10a7c7eb66105ec87ad9ea32b` |
| Working tree | **Not clean.** Modified `ROOT_CAUSE_REPORT.md` and `capabilities/visual/qa-log.jsonl` (a runtime log); untracked `docs/system-audit.md`. No source file differed from the commit. |
| Capabilities | **Stale HyperFrames records** (six recipes NOT USABLE). They were re-validated afterwards in commit `ace5999`, so a film made after that commit may be offered recipes the baseline never saw. |
| Model | `claude-sonnet-5-5`, real API, through the console with `SKILLS_INCLUDE_DRAFT=1` and the 476-template inspiration section on |
| Retrieval | Postgres hybrid (BM25 + `bge-small-en-v1.5` vectors) |
| Settings | 15 s, 30 fps, mp4 / h264 / aac. 1280x720 for 16:9, 720x1280 for 9:16, 720x720 for 1:1 |

## Folders

Each folder holds: `film.mp4`, `brief.txt` (the brief as routed), `treatment.json`, `storyboard.json` (the approved storyboard), `edit-plan.json` (the approved edit plan), `editor-output.json`, `delivery-report.json`, `qa.json`, `probe.txt`, `proxies.json` (machine proxies from the plan) and `sheets/S01.png ...` (8 frames per scene, 4x2, taken across the scene).

| Folder | Brief | Size | Result | Source (not committed, `storage/` is ignored) |
|---|---|---|---|---|
| `01-logo-brand-16x9/` | DigiKon, logo and brand colours | 1280x720 | `complete_preview` | `storage/sessions/61df7c739b74/renders/61df7c739b74-1794906567151/out/rn_f282da44c0bb4950.mp4` |
| `02-no-assets-16x9/` | Ember Roast coffee subscription, no assets | 1280x720 | `complete_preview` | `storage/sessions/60ac2cc10914/renders/` |
| `03-vertical-9x16/` | Crumb bakery app, vertical | 720x1280 | `complete_preview` | `storage/sessions/4457625c1382/renders/` |
| `04-square-1x1/` | Ledgerly invoicing, square | 720x720 | **not run** (see below) | none |

The MP4s are small (about 0.5 to 1.5 MB each) so they are committed here. Bigger ones should stay in `storage/` and be listed by path only.

## What happened in each run

- **01** needed three sessions. Session 1 (no voice-over asked) rendered only after the output settings were approved and had no audio. Session 2 escalated after Gate 1: the edit plan's speech-fit check rejected a 12-word line in a 4 s scene (`packages/render/src/audio.ts:61`, the storyboard has no such check). Session 3 (with a shorter-line sentence in the brief) escalated once (the model combined `image-scene` with `scene-composition`) and rendered on the second `/direct` of the same session. The film here is that last one.
- **02** and **03** rendered on the first attempt.
- **04 (1:1) was intentionally not run, to save credits.** It was started, its routing call finished, and the Director call was interrupted when the credit-saving rules came in. The baseline is final with briefs 1 to 3. Brief 4 can be run once, at the end, with an explicit go-ahead (about 6 real model calls); add it as `04-square-1x1/` then.

## What the baseline shows (from the plans; see `proxies.json`)

- 01: `message_thread`, `layered_cards`, `ui_demo`, `end_card`; face `sans` although the brief names Manrope and DM Serif Display; 0 `composition` scenes.
- 02: `composition`, `title_plate`, `spec_callouts`, `closing_signature`; face `serif` (system `atelier`); 1 `composition` scene.
- 03: `message_thread`, `ui_demo`, `process_flow`, `end_card`; system `saas_clarity`.
- Every effect cue is placed at its scene's start (`packages/render/src/audio.ts:66`), so cues at a non-zero offset are 0 in all three.

Scores are not recorded yet. Score them with `rubric.md`, blind where possible.

## Reproduce

Run the console (`SKILLS_INCLUDE_DRAFT=1 npm run console`), then for each brief in `briefs.md`: `POST /api/sessions`, upload (brief 1 only), `POST .../route`, `POST .../direct`, `POST .../approve` (storyboard, then edit plan), `POST .../editor`, `POST .../render` with the settings above. Rendering and QA need no model; the planning steps do.
