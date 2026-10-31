# Visual blocks

Each scene's `visual` is one of these blocks. Fields shown with their limits; every string is short display text. All blocks also take `camera` (static, push_in, pull_out, pan_left, pan_right), `reveal` (none, wipe_right, wipe_up, iris) and `backdrop` (flat, gradient, grid, dots). The scene's `overlay` text is drawn as its headline (beside or above the picture), or as the picture itself for kinetic_type and end_card.

- **message_thread**: `messages` 2-6 of {from: them|you, text <=48}; `mode` stack or pile_up. Use for: a problem told as a conversation, a hook. Not for: results, numbers.
- **ui_demo**: `window_title` <=32; `sidebar` 0-4 items <=18; `rows` 2-6 of {label <=28, tag <=14 or null, state open|busy|selected}; `cursor_target` row index or null; `confirm_text` <=28 or null. Use for: showing what a product does in one gesture. Always shown as a concept illustration, never as the real product.
- **process_flow**: `steps` 2-5 of {label <=22, detail <=36 or null}. Use for: how it works, a sequence. No branches.
- **data_chart**: `chart` bars or line; `title` <=40; `points` 3-7 of {label <=12, value 0-100 (relative height, never printed)}; `highlight_index` or null. Always labelled "Illustrative data". Use for: a trend or comparison shape with no claimed figures.
- **kinetic_type**: `style` slide_stack, word_pop or mask_rise; `emphasis_word` index or null. Animates the scene's overlay text (required, <=120). Use for: a sentence that is the idea.
- **layered_cards**: `cards` 2-4 of {title <=24, detail <=36 or null}; `depth` subtle or strong. Use for: layers or parts of a whole, with parallax. The last card is the front.
- **end_card**: `wordmark` <=24 or null (typeset text, not a logo); `button` <=24; `subline` <=40 or null. The overlay text is its headline. Use for: the closing action, held still.

- **asset_stage**: `backdrop` only. Draws the scene's `asset_refs`, the uploaded pictures; camera and reveal are fixed (the pictures carry their own animation). Use for: anything the user supplied a real picture of: a logo, a product, a screen, a team. May repeat across neighbouring scenes. Always preferred over a drawn concept when a real picture exists.

Limits: one typeface file; no supplied footage inside a block; any other block may carry one small picture through `asset_refs`, in a corner or along the top; no audio; one block per scene and one engine per scene.
