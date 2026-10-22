# Digikon AI Video Director

One Director agent (Claude) that applies seven specialist skills, retrieves knowledge through RAG, and may only
choose from a library of validated recipes. Application code validates every plan.

## What exists today

Step 1 is complete: one front door (text or voice), routing into three cases, measured footage, and a validated plan.

| Part | Where | State |
|---|---|---|
| Console (testing UI) | `apps/console` | Done: voice and text input, uploads with live analysis, routing, streamed Director run, approval |
| Router (the three cases) | `packages/router` | Done. A: little/no assets. B: full material. C: edit an existing video |
| Local speech (Whisper) | `packages/speech` | Done: any language, language detection, word timestamps, silence and music guards |
| Media probing and analysis | `packages/media` | Done: FFprobe validation and limits; measured silence, black and frozen frames, shot cuts, loudness, keyframes |
| Technical QA | `packages/qa` | Done as a module: checks a video file against the plan and produces findings with evidence and revision tickets. **Not yet connected to a render**, because rendering is not built |
| Eval harness | `packages/evals`, `evals/` | Done: 10 golden briefs and 6 router cases, with outcome checks independent of the pipeline. **Live scoring not yet run** |
| Contracts (Zod) | `packages/contracts` | Done |
| Recipe library | `recipes/` (19 original), `packages/recipes` | Done. All `draft` until a template is test-rendered |
| Seven skills | `skills/` | Written; their reference files are loaded into the prompts for each step. Evals not yet run against live Claude |
| Retrieval | `packages/rag`, `knowledge/` | Keyword (BM25) with topic filters, pinned policy notes and access rules. Qdrant not built |
| Director graph | `packages/director` | LangGraph.js: intake, asset notes, treatment, storyboard, **approval 1**, edit plan, **approval 2**. Versioned, hashed approvals; change requests loop back (max 2 per gate); `assertRenderable` guards a future render |
| Editing agent, rendering, vision pass | n/a | **Not built** |

## Run it

```bash
npm install
npm test                 # all tests, no API key needed
npm run typecheck
npm run console:demo     # UI with canned answers (clearly labelled), no key needed
npm run console          # UI with real Claude; needs ANTHROPIC_API_KEY in .env
npm run eval             # eval harness with the demo model: checks the pipeline, says nothing about Claude
npm run eval:live        # the same cases with real Claude; needs credit
```

Open http://localhost:4173. The console binds to localhost only and has no login. Do not expose it to a network.

First start downloads the Whisper model into `storage/models` (about 75 MB for `whisper-base`) and loads it in the
background; the header pill shows when it is ready. For better accuracy on non-English speech set
`WHISPER_MODEL=Xenova/whisper-small`. The model must be a `Xenova/*` export, because word timestamps need attention outputs.

CLI without the UI:

```bash
npm run director -- --project examples/coffee-ad/project.json --assets examples/coffee-ad/assets.json --facts examples/coffee-ad/facts.json --draft
```

## Rules the code enforces

- Every edit is a `recipe_id` plus parameters. Unknown recipes, out-of-range values, wrong media or aspect ratio and
  exceeded per-film limits are rejected. A recipe used with its default parameters is always valid at every scene length it supports (a test checks this).
- A claim counts as supported only if its brand fact id was actually supplied. Scenes may reference only supported claims.
- Scenes must lie inside usable footage. Usable footage is measured: black and frozen stretches are removed.
  The storyboard step is also told the longest scene the recipes can dress, and a longer scene is repaired there, not discovered later.
- The model gives durations; code assigns start times, so the timeline has no gaps or overlaps.
- One repair attempt per step, then escalation in a fixed format. Never a third attempt.
- The router decides from the real asset inventory, not just the words. Its extracted fields are validated in code, and every default it fills is shown to the user.
- Uploads are probed with FFprobe and rejected if corrupt, unsupported, empty, too large, too long or the wrong size. File names are generated server-side.
- Speech: silence is refused before Whisper runs, and a transcript made only of "Music" or "[Applause]" tags is refused.
- Asset notes record only what was measured. `content_summary` stays empty and is marked uncertain until a vision pass exists, so the Director is never told what the footage "shows".
- Each Director step is shown only the knowledge for its job (topic filters), the claims policy is pinned into the treatment step, and every skill reference file a prompt points to is loaded into it. A test fails if a prompt mentions a file the model was not given.
- Brand facts: a small fact sheet is sent whole; a large one is narrowed to the most relevant facts, while claims are always checked against the full sheet.
- Model failures (no credit, rejected key, rate limit, overload, no network, unknown model) become plain-language messages with the right HTTP status. Provider text is never passed through, so a key cannot leak into the UI.
- Platform specs are retrievable only when `verified: true`. None are verified yet, so none are used.
- QA never records a pass without a measurement, and allows black or still stretches only where the plan intended them (a dip to black, an end card).

## Known limits

- **Nothing has run against live Claude.** The Claude client, the prompts, router quality and the skill evals are all unproven until credit is available. Everything tested uses a scripted or demo model.
- The Director cannot yet see the footage: there is no vision pass. Measurements and transcripts are real; what the footage shows is unknown.
- The browser microphone path (MediaRecorder) has not been exercised in a real browser session. The server side was tested with real speech.
- Only English voices are installed on the development machine, so other languages are not tested here.
- QA covers technical checks only. Product fidelity, pacing, continuity, captions and transitions need the vision pass and a render.
- The demo model is canned. Eval results in demo mode confirm the harness and pipeline work, not that Claude plans well.
- The console buffers uploads in memory and caps a request at 400 MB. Sessions live in memory; restarting clears them.
- The keyword retrieval score (recall@3 = 0.95) is on a 20-question set written by the same author as the documents, so it is optimistic.
- Knowledge is thin (14 notes, mostly vendor-blog grade) and there are no verified platform specs or approved examples.
