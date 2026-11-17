# Polish rubric

Score each film 0 to 5 on the six rows below. Use the contact sheets (8 frames per scene) and play the MP4 with sound. Score blind where possible: hide which build made the film. Two scorers (the person and the assistant) score independently, then compare; a difference of 2 or more points on a row is discussed, not averaged away.

Anchors: 0, 3 and 5 are written; 1 and 2 sit between 0 and 3, and 4 sits between 3 and 5.

| Row | 0 | 3 | 5 |
|---|---|---|---|
| **Focal point** (the eye knows where to look in every scene) | No clear subject. Several elements of equal weight compete, or a scene is blank. | Most scenes have one clear subject, but one or two scenes split attention or the subject is small. | Every scene has one unmistakable focal point, and the eye is led to a second element in order (headline, then picture, then action). |
| **Use of space** (the frame is composed, not just filled) | Large dead areas, or crowding and clipped content. Content sits in a corner with the rest empty. | Content is placed sensibly with fair margins, but some scenes leave a third of the frame unused or feel centred by default. | Deliberate composition: scale contrast, intentional empty space, nothing floating; works for the frame shape (16:9, 9:16 or 1:1). |
| **Motion variety** (movement has craft and differs scene to scene) | Everything fades in the same way, or nothing moves. | Several kinds of entrance and at least one move that is not a fade or slide, but scenes repeat the same rhythm. | Different easing, overshoot or settle, stagger and choreography across elements, with motion that carries meaning (a reveal, a handoff) and timing that follows the voice. |
| **Typography** (type is chosen and set with care) | Hard to read, wrong sizes, ragged or orphaned lines, a default look. | Readable, sensible scale, one pairing used consistently, with an occasional awkward break or weak hierarchy. | A clear hierarchy of two or three sizes, good line breaks, a pairing that fits the tone, and brand typefaces used where supplied. |
| **Brand fidelity** (it looks like this brand) | Brand colours, logo and tone ignored or contradicted. | Palette is right and the logo appears correctly, but the fonts, tone or graphic language are generic. | Palette, logo (shown whole and unaltered), typefaces and tone all match the brand and feel designed for it, not themed. |
| **Sound sync** (sound belongs to the picture) | No sound, or sound that clearly does not match the picture. | Narration is clear and level is right, but effects and narration are not tied to on-screen events, or there are awkward silences. | Narration lands on the scene it describes, each effect lands on a visible event at the right moment, and the mix is clean at the target loudness. |

## Machine proxies (measured, not judged)

These help spot regressions. They never replace the scores. Computed per film from the stored plan and the render.

| Proxy | How to measure | Baseline source |
|---|---|---|
| **Empty-area ratio** | Per scene, at the final hold, the share of the frame (on a 192x108 grid) that differs from the scene background; report `1 - share`, the mean and the maximum across scenes. Lower mean empty area is not always better, so read it with the Use of space score. | `packages/qa/src/visual.ts` already computes `coverage` and `coverage_at_1s` per scene; reuse them. |
| **Distinct motion types** | Count of different entrance or camera kinds used across the plan (from `composition` motion entries, `camera_motion` values and transition recipes). | `storyboard.json`, `edit-plan.json` |
| **Easing types** | Count of different easing curves used (named, bezier, spring) across all composed elements. | `storyboard.json` (composition motion), later the scene graph |
| **Cues at non-zero offset** | Number of audio cues placed at a time other than their scene's start. The audio plan currently places every effect at its scene start (`packages/render/src/audio.ts:66`), so the baseline value is 0. | `proxies.json` in each baseline folder |
| **Brand font used** | Whether the typeface drawn matches a font named in the brief or brand kit (yes/no, plus the face chosen). In the baseline the brief names Manrope and DM Serif Display; the bundled faces are Inter, EB Garamond and JetBrains Mono. | `treatment.json` (`typography.face`), `packages/render/fonts/fonts.json` |
| **Distinct blocks** | Count of different visual blocks across the film, and whether `composition` was used. | `proxies.json` |

## Scoring sheet

Copy this per film. Add the build (commit hash) and scorer.

```
Film: ______   Build: ______   Scorer: ______
Focal point   0 1 2 3 4 5   note:
Use of space  0 1 2 3 4 5   note:
Motion variety 0 1 2 3 4 5  note:
Typography    0 1 2 3 4 5   note:
Brand fidelity 0 1 2 3 4 5  note:
Sound sync    0 1 2 3 4 5   note:
Total /30:
```

## Method

1. Same four briefs (`briefs.md`), same output settings, real Claude, one run each (one retry only if a run escalates).
2. Save frames, MP4, plans and reports in `baseline/` (before) or `after/<build>/` (after).
3. Score each film against this sheet; compare totals and rows, not only the total.
4. A change counts as an improvement only if the mean of the four films goes up and no row falls by more than 1 on any film.
