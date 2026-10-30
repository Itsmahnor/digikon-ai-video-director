# Before and after: the Slotly brief

Same brief both times: 20 s, 16:9, 1280x720, 30 fps, scheduling app for small business owners, no footage/logo/voice/music, two approved facts. Live Claude, both gates approved by `scripts/drive-brief.mjs` (a local experiment driver, not a production approval).

| | Before | After |
|---|---|---|
| Video | `before/before_slotly.mp4`, `before/contact.png` | `after/after_slotly.mp4`, `after/contact.png` |
| Run log | `before/run.json` (session 35e1221287dc) | `after/run.json` (session 6b94e323b6db) |
| Scenes | 5 planned, 2 drawn, 3 red "NOT RENDERED" slates | 4 planned, 4 drawn |
| What is on screen | flat navy, centred white Arial text | message thread, booking window with a moving cursor and a "Booked" confirmation, layered integration cards, an end card with wordmark, headline and button |
| Palette | fixed navy, ignores the approved off-white | the approved art direction (off-white, one green accent), measured in the frames |
| Camera/motion | dropped (reported static) | drawn: reveals, cursor path, parallax, still hold on the end card |
| Delivery label | INCOMPLETE PREVIEW | COMPLETE PREVIEW (still `final_delivery_ready: false`, see below) |

## What the new checks measured on the after film (`after/visual_qa.json`)

Measured from the real frames, not from file existence:

- every scene is a rendered picture: passed (4 of 4)
- no blank or crowded scene: passed
- planned motion is visible: passed (largest frame step per scene 21.9, 7.9, 12.7, 5.0 of 255)
- scenes share one palette: passed
- the opening shows something within a second: passed
- the ending holds still: passed (0.00 change over the last 0.6 s)
- **neighbouring scenes look different: failed.** S02 (booking window) and S03 (layered cards) both put a headline on the left and one card cluster on the right on the same cream. The check is right; I agree with it when looking at the contact sheet.

## What is still not good, honestly

- The film is not final. The delivery report says so for a separate reason: every recipe is still a `draft`, so production rendering stays blocked. That gate was not weakened.
- The repeated S02/S03 layout is an open finding. It is a Director problem (vary the composition), and the report turns it into a revision ticket for S03.
- One generated plan came back with 4 scenes, not 5, and the first live attempt came back with different scene plans. Claude's plan varies between runs, so this one comparison is evidence about one run, not a benchmark.
- The new checks do not judge taste. Hierarchy, typography quality, copy and persuasion are not measured; the report lists these as not checked. No vision model reviewed the frames.
- The audio, footage and logo gaps from the audit are not addressed by this work.

## Bugs the live render found in my own blocks, and their fixes

Running real Claude output through the real pipeline exposed three defects that the unit examples had not. The render gate refused the video each time, which is what it is for:

1. The frame-edge check treated a soft gradient backdrop as content in the corner. It now only counts strong content.
2. A six-message pile in `message_thread` ran off the top and bottom. It now shrinks as a whole to fit.
3. A camera push or pan scaled the headline and content box past the edge ring (the headline was clipped on a pan, an accent bar was clipped on a push). The headline is now outside the camera, and the camera scale is capped so the content box keeps its margin.

A fourth, in the QA itself: white cards on cream were reported as "almost empty". Coverage now also counts outlined and shadowed areas.

## Feedback and learning

- `capabilities/visual/<block>.json`: one record per block with versions, inputs, render hashes, frame measurements and what was not tried. Bound to a fingerprint of the drawing code, so a change makes the record stale until the block is validated again (`npm run capabilities:visual`).
- `capabilities/visual/qa-log.jsonl`: every visual-QA run with its findings, and what fixed them.
- Nothing is changed in approvals: the two gates, the capability registry, the adapters and project data are as they were.
