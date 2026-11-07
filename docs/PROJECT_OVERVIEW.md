# Digikon AI Video Director: project overview

Written 2026-11-07 from the code on branch `feature/semantic-retrieval-local`, the repo's architecture notes, and renders run on this machine. Where an older note disagrees with the code or a live console log, this file says so.

## 1. What it is

One Director agent (a Claude model) turns a brief into an evidence-grounded video plan. A person approves the plan twice. Only then can anything render. Everything the Director plans must be built from a library of validated recipes, and application code checks every plan.

The topic in one line: the Director creates an evidence-grounded storyboard, you approve it (Gate 1), it creates a validated edit plan, you approve that (Gate 2), and only then is rendering permitted.

## 2. The flow, end to end

```
Brief + files  ->  Intake  ->  Director  ->  Gate 1  ->  Edit plan  ->  Gate 2  ->  Editor  ->  Render gate  ->  Render  ->  QA  ->  Delivery
```

1. **Brief and assets.** You type or speak a brief, answer the setup wizard (goal, audience, platform, length, format, sound, call to action, brand) and upload files. Uploads are probed and analysed locally. Speech is transcribed with Whisper. An optional router turns chat into a structured request.
2. **Treatment.** The Director sets the hook, the beats, the claims and the art direction. Claims may only use brand facts you supplied.
3. **Storyboard.** The Director writes the scenes: purpose, timing, layout (`visual` block), camera, voice-over, audio cues, transition out. Code assigns start times so there are no gaps. Checks send the model back to repair problems (a scene too long, a voice-over that cannot be spoken in its scene, a transition nobody can render, a sound the brief rules out).
4. **Gate 1.** You approve or request changes (at most 2 revision rounds per gate, then it escalates to a person).
5. **Edit plan.** The Director chooses recipes for each scene and transition (see section 5). Code fills any gap (a missing scene-composition or transition use) and checks the plan against the live capability registry.
6. **Gate 2.** You approve the exact edit plan version. The approval, its hashes and the production plan binding are written to disk before they take effect.
7. **Editor.** Deterministic code, no model needed. It verifies the approved handoff and turns every recipe use into one concrete operation. It reports conflicts and revision requests; it never changes anything you approved.
8. **Render gate.** Stored approvals, plan integrity, the live registry, the Editor's operations and a re-plan at the real output settings must all agree. If not, nothing starts and one plain sentence says why.
9. **Rendering.** Each scene is drawn by its own engine (FFmpeg, Remotion or HyperFrames) and FFmpeg assembles them: joins, transitions, then the sound mix.
10. **QA and delivery.** Technical QA, visual QA on the finished film and the audio level check combine into one decision: `final_delivery_ready`, `complete_preview` or `incomplete_preview`. The result is an MP4 plus JSON reports under `storage/sessions/<id>/renders/<run>/`.

## 3. Roles: who decides what

| Role | What it does | What it may not do |
|---|---|---|
| **You** | Write the brief, supply files and facts, approve Gate 1 and Gate 2, decide on escalations | |
| **Director** (Claude model, `packages/director`) | All creative decisions: treatment, art direction, storyboard, voice-over, recipe choice | Use a recipe that does not exist, a claim without a supplied fact, or anything the brief rules out |
| **Art direction** | The visual part of the treatment (`ArtDirection`): audience response, concept, metaphor, palette, typography, composition, motion feel, story arc. Not a separate agent | |
| **Skills and retrieval** | Craft knowledge and playbooks shown to the Director as reference | Approve a claim or lift a limit |
| **Application code** | Validates every plan, assigns times, fills gaps, enforces gates and hashes | |
| **Editor** (`runEditor`) | Verifies the handoff and translates approved recipe uses into operations; reports conflicts | Change an approved plan, call a renderer, say a video exists |
| **Renderers** | FFmpeg (text, clips, joins, audio mix), Remotion (composed scenes), HyperFrames (text and image scenes) | Run anything that is not an approved operation |
| **QA** | Measures the finished file against the plan | Record a pass without a measurement |

## 4. Architecture

```
apps/console          Web UI (plain JS) + Hono API on 127.0.0.1:4173, no login
packages/
  contracts           Zod schemas for every record (plans, approvals, handoff, editor, render, visual, sound policy)
  router              Turns chat into a structured request (three cases: little/no assets, full material, edit existing video)
  media               FFprobe validation, silence/black/frozen/shot-cut/loudness analysis, vision, OCR
  speech              Local Whisper transcription
  rag                 Retrieval: keyword (BM25), hybrid with embeddings and pgvector
  recipes             The recipe library loader and validators
  templates           Template library used as inspiration
  director            The LangGraph graph, nodes, gates, approvals, handoff, Editor, run store
  render              Capability registry, planning, adapters, assembly, audio, scene previews
  qa                  Technical and visual checks, delivery decision
  evals               Evaluation harness and benchmarks
recipes/              Recipe definitions (animation, camera_move, shot, sound_cue, transition)
skills/               Director skills and Editor skills (Markdown)
knowledge/            Playbooks, directing principles, platform specs
templates/            Template library by category (hook, problem, solution_reveal, cta_end, ...)
capabilities/         Learned and visual capability records (what has been validated by a real render)
db/                   Postgres + pgvector migrations
storage/              Sessions, runs, approvals, renders, models (runtime data)
```

Note on retrieval: the older architecture notes say hybrid retrieval, Postgres and pgvector were not connected. The console's current start-up log reports `pgvector-hybrid` retrieval (BM25 plus vectors, `bge-small-en-v1.5`) with 117 skills, 476 templates, 40 recipes and 14 notes, so that has changed. The older notes in `architecture/` are a snapshot and are out of date on this point.

## 5. Recipes versus scene JSON

- A **recipe** is the only thing that can execute. It names the engine, template, parameter limits and per-film limits. Examples: `scene-composition`, `hard-cut`, `crossfade`, `dip-to-black`, `music-bed-duck`.
- The storyboard's **`visual` JSON** holds the content of a drawn scene (layout, text, camera, timing). The `scene-composition` recipe takes no parameters; the approved `visual` carries everything, and code adds that recipe use automatically for any scene that has a `visual`.
- The edit plan is a list of uses: `{use_id, scene_id, recipe_id, params, rationale}`. Only recipes the live capability registry says can run here are offered to the Director.

Recipe families today (about 40): animation (text cards, title, lower third, stat callout, end card, logo reveal, image scenes, asset stage), camera moves (push-in, pull-out, pan, punch-in), shots (clip play, static hold, crop), transitions (hard cut, crossfade, dip to black, directional wipe, match cut, J-cut) and sound cues (loudness normalise, music bed duck, sfx on cut).

## 6. Sound

- The brief's own sound rule wins (`packages/contracts/src/sound-policy.ts`): silent, narration only, music only, no sound effects. A visual system's usual sound is replaced by it.
- The storyboard carries voice-over per scene and audio cues. Checks enforce that a voice-over fits its scene at 2.8 words a second.
- The audio plan (`packages/render/src/audio.ts`) turns that into tracks: narration (a supplied recording or the machine's own speech synthesiser: Windows SAPI or espeak), music (supplied, or a generated bed) and effects (synthesised whoosh, hit, chime, click).
- FFmpeg mixes them after the picture is assembled: narration, ducked music, effects, loudness normalised to -16 LUFS. The picture is copied, not re-encoded.
- The levels are measured in the finished file, per scene, and the delivery report says generated sound is generated.
- Default when the brief says nothing about sound: if this machine can speak, the storyboard is sent back until it has a short voice-over (no music or effects unless asked). Added in commit `f63cc39`.

## 7. Tools and technologies

| Area | Tool |
|---|---|
| Model | Claude via the Anthropic API (default `claude-sonnet-5-5`); a canned `DemoClient` with `--demo` |
| Agent graph | LangGraph.js |
| Schemas | Zod |
| Server and UI | Hono, plain JavaScript front end |
| Speech to text | Whisper (`Xenova/whisper-base`, local) |
| Text to speech | Windows SAPI or `espeak-ng` (local) |
| Video | FFmpeg and FFprobe (bundled in `tools/ffmpeg`), Remotion, HyperFrames, a local Chrome or Edge |
| Retrieval | BM25, embeddings (`bge-small-en-v1.5`), Postgres with pgvector (Docker) |
| Tests | Vitest (`npm test`), eval harness (`npm run eval`) |

## 8. Safety rules the code enforces

- Every edit is a recipe plus parameters; unknown recipes, out-of-range values and exceeded limits are rejected.
- A claim counts only if its brand fact id was supplied.
- Nothing renders without both approvals matching the current plans and file hashes.
- A transition or capability that is not validated cannot be planned.
- Output is labelled a preview unless every recipe is production-reviewed (recipes default to `draft`).
- Model failures become plain messages; no key or provider text reaches the UI.

## 9. Known limits and open work

- Recipes are `draft`, so films are `complete_preview` and not `final_delivery_ready`.
- The recipe, block and typeface set is small, which caps how varied the films can look (three typefaces: Inter, EB Garamond, JetBrains Mono; brand fonts such as Manrope and DM Serif Display are not bundled).
- Narration is a robotic machine voice; music is a generated bed.
- Look-and-fix self-critique (`DIRECTOR_VISUAL_CRITIQUE`) is off unless switched on; draft skills are hidden unless `SKILLS_INCLUDE_DRAFT=1`.
- `ModelGateway` (budgets, call log) and the scene-graph v2 engine are not wired in.
- The console has no login and keeps sessions in memory; run it on localhost only.
- Sound mixing and the default voice-over were verified with the demo model and real local renders; they have not been run against the real Claude model.

## 10. Running it

```bash
npm install
npm test
npm run console:demo     # canned answers, no key needed
npm run console          # real Claude, needs ANTHROPIC_API_KEY in .env
npm run doctor           # checks the machine
```

Open http://localhost:4173.

## 11. Further reading in the repo

`README.md`, `architecture/CURRENT_ARCHITECTURE_FLOW.md` (older snapshot, with a diagram), `architecture/UPDATED_PLAN.md`, `architecture/UX_GUIDE.md`, `docs/RENDERER_FOUNDATION.md`, `docs/DIRECTOR_HANDOFF.md`, `docs/SKILLS.md`, `docs/TEMPLATE_LIBRARY.md`.
