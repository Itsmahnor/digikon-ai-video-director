# Project discovery report

Date: 2026-10-22. Audit only: no source, config or dependency was changed. Facts below were read from the code or produced by commands run in this session. Anything not checked is marked **unverified**.

## 0. Setup findings

- `DIGIKON_CONTEXT.md` and `CLAUDE.md` are **not in the workspace** (`D:\digikon-ai-video-director`). The current `DIGIKON_CONTEXT.md` (the new spec) exists only in the Claude project library. Place it at the repo root; it was not created here to avoid a competing copy.
- Git: branch `master`, one commit (`fb94b60 video-director added`). Uncommitted changes are limited to `apps/console/public/{app.js,index.html,styles.css}` (microphone error messages and a voice-file upload fallback). Nothing else is modified.
- Running `npm run eval` wrote a report into `storage/evals/` (git-ignored). That is the only file created besides this one.

## 1. Architecture and actual Director workflow

npm workspaces, strict TypeScript, Vitest. Packages: `contracts` (Zod), `director` (LangGraph.js), `rag`, `recipes`, `router`, `speech` (local Whisper), `media` (FFprobe/FFmpeg analysis), `qa`, `evals`; app: `apps/console` (Hono server and plain-JS UI).

Actual graph (`packages/director/src/graph.ts`):
`intake -> analyse_assets -> treatment -> storyboard -> edit_plan -> approve (interrupt) -> END`.

- Each model step is validated in code with one repair attempt, then an `Escalation` (`nodes.ts: generateWithRepair`, `escalationFor`).
- Start times are assigned by code; claims are checked against supplied facts (`enforceClaims`, `validatePlan`).
- The edit plan is a list of recipe uses (recipe id plus parameters) checked by `validateEditPlan`.
- Sessions and graph checkpoints are in memory (`MemorySaver`, `Map` in `app.ts`).

## 2. Requirements status

| Requirement (spec) | Status | Evidence |
|---|---|---|
| Structured contracts and validation | **Mostly done** | `packages/contracts/src/*`; tests `validate.test.ts`, `claims.test.ts` |
| Intake, treatment, storyboard, edit plan | **Done (offline-tested only)** | `nodes.ts`, `director.test.ts`, `grounding.test.ts` |
| Seven skills + master | **Written** | `skills/*/SKILL.md`; skill reference loading tested in `skills.test.ts`. Skill evals (`skills/*/evals/cases.md`) are prose, not executed |
| **First approval (storyboard)** | **Missing** | Graph has no pause between `storyboard` and `edit_plan`; `edit_plan` runs straight after |
| **Second approval (edit plan)** | **Partial** | `approve` node pauses once, after the edit plan, and shows treatment, scene plan and edit plan together (`graph.ts:95-103`). It does not record which version was approved |
| Approval invalidation / version freeze / hashes | **Missing** | No hash, no approval record. `Project.approval_status` exists in `schemas.ts` but is never written. The `approve` route re-checks only `status === "awaiting_approval"` (`app.ts:349`) |
| Request-revision from an approval gate | **Missing** | `ApprovalDecision` is `{approved, notes?}`; a rejection ends the run (`graph.ts:102`, edge `approve -> END`). `notes` is never used. `skills/video-director/references/revise-mode.md` exists, no code behind it |
| Asset analysis (probe, silence, black, frozen, cuts, loudness, keyframes, Whisper) | **Done** | `packages/media/src/analysis.ts`, `probe.ts`; `analysis.test.ts`, console tests |
| Visual understanding (vision pass) | **Missing** | Notes keep `content_summary` empty and mark assets "not visually inspected" (`nodes.ts: analyseAssets`). Keyframes are saved but never read by a model |
| RAG | **Partial** (section 4) | `packages/rag` |
| Canonical timeline + Remotion/HyperFrames adapters | **Missing** | `ScenePlan` + `EditPlan` are the plan representation. No timeline contract, no adapter package, no Remotion or HyperFrames dependency. Recipes carry an `implementation_ref` that points to nothing yet |
| Rendering and job tracking | **Missing** | README: "Not built"; approved plans end at `status: approved` (`cli.ts:88`) |
| Output QA | **Partial** | `packages/qa/src/technical.ts` checks a file against expectations and builds revision tickets; tested in `technical.test.ts`. Not connected to any render; no sampled-frame, caption or product-fidelity checks |
| Revision loop (QA to affected scenes, max two loops) | **Missing** | `RevisionTicket` contract and `ticketsFromFindings` exist; nothing consumes them |
| Controlled learning (record, review, regression) | **Missing** | No learning-record contract or code. The eval harness (`packages/evals`) is the only regression base |
| Reproducibility record | **Partial** | `record.ts: buildRunRecord` lists model, skills, recipes, retrieved ids. Missing: prompt/config hash, plan hashes, approval decisions, versions of retrieval index |
| Security of uploads / typed operations | **Partial, good** | Server-side file names, FFprobe validation, size/duration limits (`media/limits.ts`, `app.ts`). Only typed recipe operations are executable. Console has no auth (localhost only, documented) |
| Live Claude behaviour | **Unverified** | No credit; model id `claude-sonnet-5-5` unconfirmed live (`llm.ts`) |

Spec drift to resolve: the code still contains the **old product shape** the new spec dropped. `packages/router` and the console treat `edit_existing` as Mode C and say "the editing agent is the next milestone" (`app.ts:306`, README, `skills/video-director/references/intake-modes.md`, `router.test.ts`, `app.test.ts` case C). There is no separate Editor agent in the code, so only the Mode C routing and its wording conflict with the new spec.

## 3. Test and build status (commands run)

- `npm test`: **15 test files, 188 tests passed** (41 s).
- `npm run typecheck`: exit 0, no errors reported.
- `npm run eval` (demo model): **16/16 pass**. This checks the harness and pipeline only, not Claude's quality.
- Not run: `npm run doctor`, `npm run eval:live` (no credit), any real render (none exists), the console in a browser, real microphone path.

## 4. RAG against the SOP

Implemented (`packages/rag`):
- Six named collections, retriever interface with `retrieve` and `get` (`types.ts`).
- BM25 keyword retrieval, topic filters, pinned policy notes, token budget (`keyword.ts`, `nodes.ts`).
- Eligibility filters applied before ranking: platform specs only when `verified`, brand facts only for the matching `project_id`, recipes by status/type/aspect/duration/media.
- Source and grade on every document; one 20-question retrieval eval (recall@3 = 0.95 per README; the author wrote both documents and questions, so it is optimistic).

Gaps against the SOP (all verified by absence in the code):
- No ingestion pipeline, queue, catalog database, checksums, versions, quarantine, or safe re-indexing: knowledge is read from markdown files at startup (`docs.ts: loadKnowledge`).
- Chunking: one file is one chunk; no section-aware chunking or overlap.
- Chunk metadata is far thinner than SOP 6.6 (no document version, tenant, ACL reference, lifecycle state, embedding version).
- No vector or hybrid search, fusion or reranking; no embeddings (Qdrant/BGE-M3 not built, and Docker is not available).
- No citation validation: citation ids are recorded (`citations` in state) but not checked against claims in output.
- Evaluation: single small set, no held-out split, no abstention, stale-version, poisoning or ACL cases beyond a few unit tests.
- No timeouts, circuit breakers, retries with jitter, or monitoring for retrieval. Only LLM errors are classified (`llm.ts: classifyLlmError`).
- Content is thin: 14 knowledge notes, **no verified platform specs** (`knowledge/platform_specs/README.md` only), no approved examples.
- Compatible with the spec rule "do not add Qdrant or paid infrastructure without approval": nothing was added.

## 5. Rendering and approval status

- Rendering: nothing exists. No Remotion, HyperFrames adapter, render job, preview, or export. The 19 recipes (`recipes/`) are all `draft`; no template has been test-rendered.
- Approval: one gate after the edit plan; the UI and `POST /api/sessions/:id/approve` handle approve/reject only. There is no storyboard gate, no revision request, no stored approval record, no version freeze, and no server-side re-check of plan version, asset availability or validation at approval time.
- Because nothing renders yet, no render can happen without approval today. That guarantee must be built into the render step when it is added, not assumed.

## 6. Risks and open decisions

1. Nothing has run on live Claude: prompts, router quality, and the model id are unproven. Blocked on credit (also: rotate the API key that was pasted into chat earlier).
2. Spec drift (Mode C and "editing agent" wording) can mislead future work. Decision needed: remove or park Mode C routing.
3. Canonical timeline: decide whether it is a new contract derived from `ScenePlan` + `EditPlan`, or whether `EditPlan` is extended. Needed before any adapter.
4. Remotion and HyperFrames license, runtime and capability checks are not done (spec requires verification). No dependency exists yet.
5. Persistence: sessions and checkpoints are in memory, so approvals and history vanish on restart. Approval records should be persisted before rendering matters (a file or SQLite store would avoid new infrastructure; Postgres is in `docker-compose.yml` but Docker is unavailable).
6. Environment: C: drive nearly full, no Docker, no working microphone.
7. Uncommitted console changes exist; the user commits by hand.

## 7. Prioritized plan from the current code

1. **Two-gate approval with versions** (smallest change with the largest spec gap; offline testable).
2. Remove or park Mode C wording and routing to match the new spec.
3. Revision loop from approval gates and QA tickets (re-run only affected scenes, max two loops, then escalate).
4. Handoff package: one validated file (scene plan, edit plan, asset refs, claims, QA expectations, run record, approval hashes) that a future renderer must consume.
5. Controlled learning: learning-record contract, review states, regression run via the existing eval harness before any skill change.
6. Persistence of sessions, approvals and run records (no new infrastructure).
7. Render path: canonical timeline contract, then a Remotion adapter after license and capability verification, then connect `packages/qa` to the real output. HyperFrames stays represented as a stubbed adapter until verified.
8. RAG: ingestion with versions/checksums, then an independent benchmark before any embedding or Qdrant decision.
9. Vision pass on keyframes (needs credit).

## 8. Recommended next task and acceptance criteria

**Task: two human approval gates with versioned, frozen approvals.**

Acceptance criteria:
- The graph pauses after the storyboard (gate 1, showing treatment and scene plan) and does not run `edit_plan` until the user approves.
- A second pause after the validated edit plan (gate 2, showing the edit plan next to the approved storyboard).
- Each approval is an `ApprovalRecord` (new contract): stage, plan version, SHA-256 of the canonical plan JSON, decision, notes, timestamp.
- Rejecting with notes, or requesting changes, creates a new plan version and invalidates the earlier approval; an approval of version N can never authorize version M.
- A single `assertRenderable(state)` check re-validates both approvals, hashes, and plan validity server-side; it returns a refusal with reasons otherwise. It does not render anything.
- Console: both gates visible in the UI and API (`/approve` accepts a stage and version; a stale version returns 409).
- Tests cover: skipping gate 1 is impossible, stale approval rejected, edited plan invalidates approval, reject path, and the existing 188 tests still pass (updated where the single-gate flow is asserted).
- No new dependencies or infrastructure.

Waiting for your approval before changing any application code.
