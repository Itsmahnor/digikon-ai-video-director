# Template library, Release 1 (tooling and first batch)

Branch `feature/templates-r1`. Nothing here is read by the Director or the Editor yet, the scene-graph engine is still behind `SCENE_GRAPH` (default off), and no template is `reviewed` until a person approves it.

## What a template is

A template is one JSON file, `templates/<category>/<template_id>.json`, a `digikon.template` record **format version 2** (`packages/contracts/src/template-record.ts`; the draft version 1 record is unchanged). Git is the source of truth; the database is built from the files.

It carries: `template_id`, `version`, `content_hash`, `category` (one of 18), `family`, `variant_of`, `variant_axes`, `archetype`, `tags` (mood, energy, pacing, industry, tone, motion personality, type personality), `needs` (media, text slots with limits and examples, aspect ratios, duration range), `scene_graph` (one validated scene graph v2 per aspect ratio, because positions are pixels), `params` (ranges), `palette_rules` and `type_rules`, `engine_support`, `source` (`authored | adapted | generated`, origin, licence, `licence_ok`), `evidence` refs, `status` (`draft | reviewed`) and `retrieval_text`. The content hash covers the design only (not `status` or `evidence`), so reviewing a template does not change its identity.

The 18 categories: 12 scene categories (hook, problem, solution_reveal, ui_demo, feature_highlight, process, data_proof, comparison, social_proof, brand_moment, transition_beat, cta_end) and 6 supporting ones (kinetic_type, transitions, backgrounds, camera_moves, charts, lower_thirds_captions).

## Tooling

```
npm run templates -- build [--per-family N] [--only <family|category>] [--no-write] [--sheets]
npm run templates -- validate [category]        # all three aspect ratios; writes templates/_reports/validation.json; exit 1 on a failure
npm run templates -- dedupe                     # near-duplicates under the documented thresholds
npm run templates -- stats                      # valid / distinct / skeletons per category against the 100 target
npm run templates -- review-queue [category] [--limit N]
npm run templates -- review-queue approve|reject|changes <id> --reason "..." [--reviewer name]
npm run templates -- ingest [--render]          # seeds the 18 categories, stores templates + text and look embeddings
npm run templates -- search "<text>" [--category c] [--aspect 9:16] [--status draft,reviewed] [--proven] [--k 8]
npm run new-template -- <category> <id> "<Title>" ["<description>"]   # scaffold: record + validation + real preview + embeddings
```

`ingest`/`search` use `DATABASE_URL` (Postgres + pgvector) when set, otherwise an in-memory store. `ingest <dir>` and `dedupe <dir>` keep their old meaning for the draft version 1 records.

**Validate** runs the scene-graph validator (contract, timing, text fits and stays in the safe area, contrast against what is behind it, every text fully shown for 0.8 s) on each graph with the template's reference palette, plus slot examples, palette contrast and the content hash.

**Distinctness** uses two measures together (`packages/templates/src/dedupe.ts`, thresholds versioned and written into `templates/_reports/build.json`):

- structural similarity: Jaccard overlap of design decisions (layout cells, alignment, animated properties, stagger unit, motion personality, type pairing and font roles, palette roles as tokens, backdrop). Colours are not in it.
- look similarity: cosine of CLIP (Xenova/clip-vit-base-patch32, local, q8) embeddings of the **real rendered 16:9 preview frame**.

A candidate is a duplicate when `struct >= 0.78 and look >= 0.93`, or when `look >= 0.975`. Candidates are considered bases first, then variants by id, per category. Only distinct templates are written and counted. The thresholds were set by looking at the distributions and contact sheets of this first batch, not tuned against a labelled set.

**Review queue**: lists draft templates with no decision for their current hash beside their three nearest neighbours; decisions are appended to `templates/_reviews/reviews.jsonl` (reason required), approval sets `status: reviewed` and adds review evidence, and `ingest` mirrors decisions into `template_review`. A rejected template stops counting.

**search_templates** (`packages/templates/src/search.ts`): hard filters (category, aspect, status, proven-only with optional minimum uses, excluded families), then hybrid retrieval (BM25 + vector with reciprocal-rank fusion, the existing `HybridRetriever`), MMR for variety and a no-repeat penalty from `template_usage` for the film being directed. "Proven" means reviewed, licence ok, has review evidence, valid at every declared aspect, and (optionally) used at least N times.

## First batch, honestly

75 hand-authored families across all 18 categories, expanded deterministically along declared axes (palette from 8, type pairing from 5, motion personality from 5, alignment, flip, backdrop from 7, stagger unit, camera move; one to three axes at a time, seeded by the family id), 14 candidates per family.

| category | families | variants generated | candidates | valid at 16:9, 9:16, 1:1 | distinct | distinct skeletons | of 100 |
|---|---|---|---|---|---|---|---|
| hook | 4 | 56 | 60 | 60 | 27 | 10 | 27% |
| problem | 4 | 56 | 60 | 60 | 25 | 6 | 25% |
| solution_reveal | 4 | 56 | 60 | 60 | 29 | 4 | 29% |
| ui_demo | 3 | 42 | 45 | 45 | 20 | 4 | 20% |
| feature_highlight | 4 | 56 | 60 | 60 | 29 | 5 | 29% |
| process | 4 | 56 | 60 | 60 | 26 | 4 | 26% |
| data_proof | 4 | 56 | 60 | 60 | 31 | 6 | 31% |
| comparison | 4 | 56 | 60 | 60 | 27 | 4 | 27% |
| social_proof | 4 | 56 | 60 | 60 | 30 | 7 | 30% |
| brand_moment | 3 | 42 | 45 | 45 | 21 | 6 | 21% |
| transition_beat | 3 | 42 | 45 | 45 | 16 | 6 | 16% |
| cta_end | 4 | 56 | 60 | 60 | 28 | 10 | 28% |
| kinetic_type | 5 | 70 | 75 | 75 | 32 | 15 | 32% |
| transitions | 4 | 56 | 60 | 60 | 20 | 4 | 20% |
| backgrounds | 5 | 70 | 75 | 75 | 17 | 5 | 17% |
| camera_moves | 6 | 84 | 90 | 90 | 40 | 3 | 40% |
| charts | 5 | 70 | 75 | 75 | 23 | 5 | 23% |
| lower_thirds_captions | 5 | 70 | 75 | 75 | 35 | 10 | 35% |
| **total** | **75** | **1050** | **1125** | **1125** | **476** | **114** | **26%** |

How to read it: 476 templates pass validation and the distinctness rule, which is 26% of the 100-per-category target, not 100%. Most of them are **re-skins of 75 hand-designed structures** (a different palette, type pairing, alignment, backdrop or camera over the same layout). "Distinct skeletons" is the number of different structures among the distinct templates (114 by the structural measure); that, not 476, is the honest measure of design variety, and the long-term goal of 100 distinct templates per category needs many more hand-authored structures, not more variants. The 649 candidates that were dropped are listed with what they duplicate in `templates/_reports/build.json`.

Measured limits of the distinctness rule: it compares one held frame. Variants that differ only in motion personality (snappy vs smooth vs mechanical) look identical at that frame and are therefore counted as duplicates even though they move differently.

## Previews

`docs/templates/<category>.png`: one contact sheet per category of real Remotion renders of the 16:9 frame (base family first, then up to three accepted variants per family; transitions, backgrounds and camera moves are taken mid-motion). Previews of the other two aspect ratios are validated by the scene-graph validator but were not rendered into sheets. Fonts are EB Garamond and JetBrains Mono from the renderer, plus the machine's generic sans, so the sans in a preview depends on the machine that rendered it.

## Known limits of the engine as it stands

- No alpha: lower thirds and captions render on the palette background, not over footage; compositing them is not built.
- No gradients, blur, shadows, arcs or per-node font files; per-element font **roles** (display, body, mono) were added for this work (additive, optional).
- The `line` chart renders as bars, so charts use bars and shapes only.
- A scene graph's text is wrapped at author time with the validator's estimating meter (wide), so real text is usually narrower than its box. Instantiating a template with new text must re-wrap and re-validate; that step is not built.
- Parameters are declared (`duration_scale`) but nothing applies them yet.
