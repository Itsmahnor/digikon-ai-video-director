# Visual blocks

Each scene's `visual` is one of these blocks. Fields shown with their limits; every string is short display text. All blocks also take `camera` (static, push_in, pull_out, pan_left, pan_right), `reveal` (none, wipe_right, wipe_up, iris) and `backdrop` (flat, gradient, grid, dots, spotlight, vignette, paper). The scene's `overlay` text is drawn as its headline (beside or above the picture), or as the picture itself for kinetic_type, title_plate, quote_statement and end_card. Use only the blocks the prompt lists for this film's visual system.

- **message_thread**: `messages` 2-6 of {from: them|you, text <=48}; `mode` stack or pile_up. Use for: a problem told as a conversation, a hook. Not for: results, numbers.
- **ui_demo**: `window_title` <=32; `sidebar` 0-4 items <=18; `rows` 2-6 of {label <=28, tag <=14 or null, state open|busy|selected}; `cursor_target` row index or null; `confirm_text` <=28 or null. Use for: showing what a product does in one gesture. Always shown as a concept illustration, never as the real product.
- **process_flow**: `steps` 2-5 of {label <=22, detail <=36 or null}. Use for: how it works, a sequence. No branches.
- **data_chart**: `chart` bars or line; `title` <=40; `points` 3-7 of {label <=12, value 0-100 (relative height, never printed)}; `highlight_index` or null. Always labelled "Illustrative data". Use for: a trend or comparison shape with no claimed figures.
- **kinetic_type**: `style` slide_stack, word_pop or mask_rise; `emphasis_word` index or null. Animates the scene's overlay text (required, <=120). Use for: a sentence that is the idea.
- **layered_cards**: `cards` 2-4 of {title <=24, detail <=36 or null}; `depth` subtle or strong. Use for: layers or parts of a whole, with parallax. The last card is the front.
- **end_card**: `wordmark` <=24 or null (typeset text, not a logo); `button` <=24; `subline` <=40 or null. The overlay text is its headline. Use for: the closing action, held still.

- **title_plate**: `eyebrow` <=32 or null; `subline` <=60 or null; `plate` bare, hairline or letterbox. The overlay text is a title alone on the frame, tracked out and settling (required). Use for: a reveal, a chapter, a name. Not for: a list.
- **quote_statement**: `attribution` <=36 or null. The overlay text is set as a sentence somebody means (required). Use for: a belief, a promise. Never a quote invented for a real person.
- **spec_callouts**: `form` orb, slab, column or ring (an abstract drawn form, never the real product); `style` spotlight (a lit object), blueprint (a technical drawing) or chalk (a blackboard diagram); `notes` 2-5 of {label <=22, detail <=32 or null}. Use for: what matters about one subject, the parts of an idea, specifications. A stated specification needs an approved claim.
- **split_panels**: `panels` 2-4 of {word <=14, note <=24 or null}; `axis` columns or rows. Colour panels slide in with one big word each; the overlay text is a small caption. Use for: an editorial rhythm, a campaign statement, a contrast.
- **route_map**: `stops` 2-5 of {label <=20, note <=28 or null}; `shape` coast, zigzag or arc. A line draws itself through the stops. A drawn impression of a route, never real geography. Use for: a journey, stages travelled.
- **timeline_path**: `marks` 2-5 of {when <=12, label <=24}. Moments along one line. Use for: a history, a roadmap, chapters. A real date or figure needs an approved claim.
- **closing_signature**: `wordmark` <=28 or null (typeset, not a logo); `action` <=36; `subline` <=48 or null. The overlay text is one line under the name. Use for: a quiet close with no button.

- **asset_stage**: `backdrop` only. Draws the scene's `asset_refs`, the uploaded pictures; camera and reveal are fixed (the pictures carry their own animation). Use for: anything the user supplied a real picture of: a logo, a product, a screen, a team. May repeat across neighbouring scenes. Always preferred over a drawn concept when a real picture exists.

Limits: three typefaces (sans, serif, mono); no supplied footage inside a block; any other block may carry one small picture through `asset_refs`, in a corner or along the top; sound comes from the storyboard's voiceover and audio_cues, not from a block; one block per scene and one engine per scene.

## Composing a scene yourself (the `composition` visual)

The blocks above are starting points, not a menu you must pick from. A scene's `visual` may instead be `{"block":"composition","intent":"...","elements":[...]}`, a layout you write for this film: text and shape elements placed on the frame with their own type, colour and motion. Use it when no block fits the scene's idea, and always when two scenes would otherwise look alike.

- Positions and widths are shares of the frame (0 to 1). A text `size` is a share of the shorter side (0.03 label, 0.05 body, 0.08 to 0.12 headline). Give a `portrait` override when 9:16 needs another position or size.
- Colours are the film's palette tokens (text, muted, accent, accent_2, surface, background). Fonts are roles: display, body, mono.
- Every element has its own `motion`: enter (none, fade, rise, drop, slide_left, slide_right, scale_in, wipe), delay and duration as shares of the scene, easing, and for text a stagger by line, word or character. Everything must be fully shown for at least 0.8 s before the scene ends.
- Every word must come from the scene's overlay text, voiceover, its claims, the brand facts, the brief or the treatment's own lines. No new copy and no new figures: the checker rejects them and sends the storyboard back.
- Nothing may leave the frame, overlap other text, or be illegible on its background. Pictures are not elements: place supplied pictures with `asset_refs`.
- Compose the layout from the idea: a sequence that draws itself, a line with moments on it, a form with labelled parts, a frame cut into panels, one huge word. Do not reuse one layout in two scenes.
