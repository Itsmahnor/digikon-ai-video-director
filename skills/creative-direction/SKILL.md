---
name: creative-direction
description: Gives every film a creative frame before any scene is planned: the viewer response, one concept, art direction, an arc, and a distinct picture for each scene. Use at the treatment and again at the storyboard.
version: 0.1.0
owner: Digikon
---

# creative-direction

A film that is only correct looks generic. Decide what it is about visually, then hold every scene to that decision.

## Inputs
Brief, audience, platform, approved facts, the supplied assets, and (at the storyboard) the treatment with its art direction.

## Procedure (treatment)
1. **Viewer response.** Say what the viewer should think, feel or do by the end, in the audience's words (`audience_response`). "Learn about the product" is not a response; "feel relief and start the trial" is.
2. **One concept.** One idea the whole film is built on (`concept`). Add a `visual_metaphor` only when it clarifies the message (a tangle that untangles). Otherwise set it to null. Never add novelty for its own sake.
3. **Art direction.** Choose a palette that suits the audience and the product, not a default dark navy: six colours, with legible text on the background and on panels. Choose type weight, scale and case, one composition rule (where the headline sits, how much space), and a motion language (feel, easing, one sentence). One typeface file exists, so weight, scale and case are what can vary.
4. **Arc.** Write what the opening, the development and the conclusion each do. The opening must show something concrete from the first frame. The conclusion holds still on one action.
5. Beats follow the arc. Each beat has a different job.

## Procedure (storyboard)
1. Give every scene a `visual_purpose`: what its picture does that no other scene's does. No two scenes may share one.
2. Give every scene a `visual`: a structured spec of one block from references/visual-blocks.md. Pick the block by what the scene must communicate, not by habit. A neighbouring scene must use a different block, and no block may carry more than a third of a film.
3. Use `kinetic_type` for a sentence that is the idea. Use a plain `end_card` only to close. Do not make a text-only scene the default; use one only when words alone are the best choice, and say why in `visual_purpose`.
4. Choose the scene's camera move, reveal and backdrop to serve its purpose, and the shot's `camera_motion` to match the visual's camera. Vary them across the film; keep them inside the art direction's motion language.
5. Scene text belongs in `overlay`. Sample content in a visual (messages, rows, labels) is illustrative and must not state results, prices or numbers.
6. Keep colour, type and motion consistent across scenes (the design system), while the pictures differ.
7. **Layout limits.** The renderer fits the picture to the real frame: it measures text with the font, wraps long labels onto more lines, picks a column, row or grid for steps, widens or moves a sidebar, and shows steps in pages inside the approved duration when one page cannot hold them. It never cuts a word and never draws text below the legible floor (about 3.4% of the short side of the frame). So write the wording you want, keep each label as short as it can be (under about 28 characters), and do not stack more steps or rows than the picture can carry. If a render is refused for layout, the reason names the area in pixels, the sizes tried and what did not fit: shorten that wording, split the scene, or choose another block. Do not ask for smaller text.
8. A transition is chosen to do a job. A match_cut is only honest when the last picture of one scene and the first picture of the next share a shape, a position and a background; the assembler measures that, and a join that does not match is reported as missing rather than passed off as a match cut. Use the match-cut recipe for it, never the hard-cut recipe.

## Never
- Open on a logo or a title card, or end without one clear action.
- Use the same block in two neighbouring scenes, or give two scenes the same visual purpose.
- Show a product screen as real, a chart as measured data, or a typeset name as a logo. The renderer labels them as concept illustrations; do not claim otherwise.
- Put a % or currency sign in drawn text unless an approved claim supports it.
- Ask for a block or motion that the reference does not list.

## Failure conditions
A scene that needs live footage, a real product capture or a real logo that was not supplied: say so in `unresolved`; do not draw it as real.

## Evals
See evals/cases.md.
